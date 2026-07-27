import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { EmploymentRepository } from '../../org/persistence/org.repositories.js';
import {
  createKnowledgeExamRun,
  examRunEvent,
  type KnowledgeExamRun,
} from '../domain/index.js';
import { KnowledgeExamRunRepository } from '../persistence/knowledge-exam-run.repository.js';
import { KnowledgeOutboxWriter } from '../persistence/knowledge-outbox.writer.js';
import {
  CourseVersionRepository,
  TrainingAssignmentRepository,
} from '../persistence/knowledge.repositories.js';

export interface KnowledgeExamRunSummary extends Record<string, unknown> {
  readonly id: string;
  readonly assignmentId: string;
  readonly courseVersionId: string;
  readonly attemptNumber: number;
  readonly questionMode: KnowledgeExamRun['questionMode'];
  readonly gradingPolicyVersion: string;
  readonly passingRule: KnowledgeExamRun['passingRule'];
  readonly gradingSlaMinutes: number;
  readonly manualReviewSlaMinutes: number;
  readonly manualReviewRequired: boolean;
  readonly status: KnowledgeExamRun['status'];
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly submittedAt: string | null;
  readonly submissionReason: KnowledgeExamRun['submissionReason'];
  readonly timedOut: boolean;
  readonly finalAttemptId: string | null;
  readonly version: number;
}

/** 考试运行命令面；仅保存不透明引用，不接收答案、标准答案或客户端成绩。 */
@Injectable()
export class KnowledgeExamRunService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly courses: CourseVersionRepository,
    private readonly assignments: TrainingAssignmentRepository,
    private readonly runs: KnowledgeExamRunRepository,
    private readonly outbox: KnowledgeOutboxWriter,
    private readonly profiles: AccessProfileRepository,
    private readonly employments: EmploymentRepository,
  ) {}

  async start(
    assignmentId: string,
    key: string,
  ): Promise<{ readonly examRun: KnowledgeExamRunSummary }> {
    this.assertScope('erp:knowledge:exam:start');
    const assignmentSnapshot = await this.assignments.findById(assignmentId);
    if (assignmentSnapshot === null) throw new NotFoundException({
      code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在',
    });
    await this.assertAssignmentOwnership(assignmentSnapshot.onboardingInstanceId);
    try {
      return await this.idempotency.execute(
        'knowledge.exam_run.start',
        key,
        { assignmentId },
        async (session) => {
        const assignment = await this.assignments.findById(assignmentId, session);
        if (assignment === null) throw new NotFoundException({
          code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在',
        });
        await this.assertAssignmentOwnership(assignment.onboardingInstanceId, session);
        const active = await this.runs.findActiveByAssignment(assignmentId, session);
        if (active !== null) return { examRun: summary(active) };
        if (assignment.status === 'completed' || assignment.status === 'expired') {
          throw new ConflictException({
            code: 'KNOWLEDGE_ASSIGNMENT_TERMINAL', message: '终态培训任务不能开始考试',
          });
        }
        const course = await this.courses.findById(assignment.courseVersionId, session);
        if (
          course === null ||
          !assignment.examRequired ||
          course.questionBankRef === null ||
          course.questionBankDigest === null ||
          course.questionMode === null ||
          course.gradingPolicyVersion === null ||
          course.passingScoreBps === null ||
          course.maxAttempts === null ||
          course.timeLimitMinutes === null ||
          course.passingRule === null ||
          course.gradingSlaMinutes === null ||
          course.manualReviewSlaMinutes === null
        ) throw new ConflictException({
          code: 'KNOWLEDGE_EXAM_NOT_CONFIGURED', message: '该培训任务未配置完整考试策略',
        });
        const attemptNumber = await this.runs.nextAttemptNumber(assignmentId, session);
        if (attemptNumber > course.maxAttempts) throw new ConflictException({
          code: 'KNOWLEDGE_EXAM_ATTEMPTS_EXHAUSTED', message: '已达到课程最大考试次数',
        });
        const now = new Date();
        const run = createKnowledgeExamRun({
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
          assignmentId,
          courseVersionId: course.id,
          questionBankRef: course.questionBankRef,
          questionBankDigest: course.questionBankDigest,
          attemptNumber,
          questionMode: course.questionMode,
          gradingPolicyVersion: course.gradingPolicyVersion,
          passingRule: course.passingRule,
          passingScoreBps: course.passingScoreBps,
          maxAttempts: course.maxAttempts,
          timeLimitMinutes: course.timeLimitMinutes,
          manualReviewRequired: course.manualReviewRequired,
          gradingSlaMinutes: course.gradingSlaMinutes,
          manualReviewSlaMinutes: course.manualReviewSlaMinutes,
        }, now);
        await this.runs.insert(run, session);
        await this.outbox.append(examRunEvent(run, 'knowledge.exam.run.requested'), session);
        return { examRun: summary(run) };
        },
      );
    } catch (caught) {
      if (!isDuplicateKey(caught)) throw caught;
      const active = await this.runs.findActiveByAssignment(assignmentId);
      if (active === null) throw caught;
      return { examRun: summary(active) };
    }
  }

  async submit(
    id: string,
    expectedVersion: number,
    key: string,
    submissionRef: string,
  ): Promise<{ readonly examRun: KnowledgeExamRunSummary }> {
    this.assertScope('erp:knowledge:exam:submit');
    const runSnapshot = await this.runs.findById(id);
    if (runSnapshot === null) throw new NotFoundException({
      code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND', message: '考试运行不存在',
    });
    const assignmentSnapshot = await this.assignments.findById(runSnapshot.assignmentId);
    if (assignmentSnapshot === null) throw new NotFoundException({
      code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在',
    });
    await this.assertAssignmentOwnership(assignmentSnapshot.onboardingInstanceId);
    return this.idempotency.execute(
      'knowledge.exam_run.submit',
      key,
      { id, expectedVersion, submissionRef },
      async (session) => {
        const existing = await this.runs.findById(id, session);
        if (existing === null) throw new NotFoundException({
          code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND', message: '考试运行不存在',
        });
        const assignment = await this.assignments.findById(existing.assignmentId, session);
        if (assignment === null) throw new NotFoundException({
          code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在',
        });
        await this.assertAssignmentOwnership(assignment.onboardingInstanceId, session);
        if (
          existing.submissionRef === submissionRef &&
          ['submitted', 'pending_review', 'graded'].includes(existing.status)
        ) {
          return { examRun: summary(existing) };
        }
        if (
          existing.status !== 'in_progress' ||
          existing.version !== expectedVersion
        ) throw new ConflictException({
          code: 'KNOWLEDGE_EXAM_RUN_STATE_CONFLICT', message: '考试运行状态或版本冲突',
        });
        const now = new Date();
        if (existing.deadlineAt === null || Date.parse(existing.deadlineAt) <= now.getTime()) {
          throw new ConflictException({
            code: 'KNOWLEDGE_EXAM_RUN_EXPIRED', message: '考试已到时，等待自动提交',
          });
        }
        const updated = await this.runs.submit(
          id,
          expectedVersion,
          submissionRef,
          now,
          session,
        );
        if (updated === null) throw new ConflictException({
          code: 'KNOWLEDGE_EXAM_RUN_STATE_CONFLICT', message: '考试运行状态或版本冲突',
        });
        await this.outbox.append(
          examRunEvent(updated, 'knowledge.exam.run.submitted'),
          session,
        );
        return { examRun: summary(updated) };
      },
    );
  }

  async get(id: string): Promise<KnowledgeExamRunSummary> {
    this.assertScope('erp:knowledge:exam:read');
    const run = await this.runs.findById(id);
    if (run === null) throw new NotFoundException({
      code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND', message: '考试运行不存在',
    });
    const assignment = await this.assignments.findById(run.assignmentId);
    if (assignment === null) throw new NotFoundException({
      code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在',
    });
    await this.assertAssignmentOwnership(assignment.onboardingInstanceId);
    return summary(run);
  }

  private async assertAssignmentOwnership(
    onboardingInstanceId: string,
    session?: ClientSession,
  ): Promise<void> {
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') {
      if (
        !['service', 'system_job'].includes(actor.actorType) ||
        !actor.scopes.includes('erp:knowledge:exam:admin')
      ) throw new ForbiddenException({
        code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED',
        message: '考试运行只允许本人或受信管理服务访问',
      });
      return;
    }
    {
      const profile = await this.profiles.resolveActive(
        this.context.getTenantRequired().tenantId,
        actor.actorId,
        session,
      );
      const employment = profile === null
        ? null
        : await this.employments.findOpenByEmployeeId(profile.employeeId, session);
      if (
        profile === null ||
        employment === null ||
        employment.onboardingInstanceId !== onboardingInstanceId
      ) throw new ForbiddenException({
        code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED',
        message: '只能读取本人有效任职对应的考试运行',
      });
    }
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'KNOWLEDGE_SCOPE_REQUIRED', message: `缺少 ${scope}`,
      });
    }
  }
}

function isDuplicateKey(caught: unknown): boolean {
  return typeof caught === 'object' && caught !== null &&
    'code' in caught && caught.code === 11_000;
}

function summary(run: KnowledgeExamRun): KnowledgeExamRunSummary {
  return Object.freeze({
    id: run.id,
    assignmentId: run.assignmentId,
    courseVersionId: run.courseVersionId,
    attemptNumber: run.attemptNumber,
    questionMode: run.questionMode,
    gradingPolicyVersion: run.gradingPolicyVersion,
    passingRule: run.passingRule,
    gradingSlaMinutes: run.gradingSlaMinutes,
    manualReviewSlaMinutes: run.manualReviewSlaMinutes,
    manualReviewRequired: run.manualReviewRequired,
    status: run.status,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    submittedAt: run.submittedAt,
    submissionReason: run.submissionReason,
    timedOut: run.timedOut,
    finalAttemptId: run.finalAttemptId,
    version: run.version,
  });
}
