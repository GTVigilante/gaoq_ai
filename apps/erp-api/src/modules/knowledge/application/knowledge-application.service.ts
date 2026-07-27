import { createHash } from 'node:crypto';

import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  AccessProfileRepository,
  type AccessProfileSnapshot,
} from '../../identity/access-profile.repository.js';
import { OnboardingApplicationService } from '../../onboarding/application/onboarding-application.service.js';
import type { Employee, Employment } from '../../org/domain/index.js';
import {
  EmployeeRepository,
  EmploymentRepository,
} from '../../org/persistence/org.repositories.js';
import {
  KnowledgeDomainError,
  assignmentEvent,
  completeTrainingAssignment,
  courseEvent,
  createCourseVersion,
  createExamAttempt,
  createTrainingAssignment,
  examGradedEvent,
  onboardingAttestedEvent,
  publishCourseVersion,
  recordTrainingProgress,
  retireCourseVersion,
  type CourseVersion,
  type ExamAttempt,
  type TrainingAssignment,
} from '../domain/index.js';
import { KnowledgeOutboxWriter } from '../persistence/knowledge-outbox.writer.js';
import { KnowledgeSearchIndexTaskWriter } from '../persistence/knowledge-search-index-task.writer.js';
import {
  CourseVersionRepository,
  ExamAttemptRepository,
  KnowledgeEvidenceRepository,
  KnowledgeWriteConflictError,
  TrainingAssignmentRepository,
} from '../persistence/knowledge.repositories.js';
import {
  KnowledgeContentVerificationPort,
  KnowledgeGradingPort,
  KnowledgeSearchPort,
} from './knowledge-ports.js';

export interface CourseSummary extends Record<string, unknown> {
  readonly id: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly title: string;
  readonly examRequired: boolean;
  readonly passingScoreBps: number | null;
  readonly questionMode: CourseVersion['questionMode'];
  readonly timeLimitMinutes: number | null;
  readonly maxAttempts: number | null;
  readonly gradingPolicyVersion: string | null;
  readonly passingRule: CourseVersion['passingRule'];
  readonly gradingSlaMinutes: number | null;
  readonly manualReviewSlaMinutes: number | null;
  readonly manualReviewRequired: boolean;
  readonly status: CourseVersion['status'];
  readonly version: number;
}

export interface TrainingAssignmentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly onboardingInstanceId: string;
  readonly courseVersionId: string;
  readonly mandatory: boolean;
  readonly examRequired: boolean;
  readonly dueDate: string;
  readonly status: TrainingAssignment['status'];
  readonly progressBps: number;
  readonly version: number;
}

export interface ExamAttemptSummary extends Record<string, unknown> {
  readonly id: string;
  readonly assignmentId: string;
  readonly attemptNumber: number;
  readonly scoreBps: number;
  readonly passed: boolean;
  readonly gradedAt: string;
}

export interface PersonalTrainingAssignmentView extends Record<string, unknown> {
  readonly id: string;
  readonly course: CourseSummary;
  readonly mandatory: boolean;
  readonly examRequired: boolean;
  readonly dueDate: string;
  readonly status: TrainingAssignment['status'];
  readonly progressBps: number;
  readonly version: number;
}

export interface PersonalKnowledgeSearchItem extends Record<string, unknown> {
  readonly course: CourseSummary;
  readonly snippetText: string;
  readonly highlights: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly scoreBps: number;
  readonly indexedAt: string;
}

export interface PersonalKnowledgeSearchResult extends Record<string, unknown> {
  readonly items: readonly PersonalKnowledgeSearchItem[];
  readonly nextCursor: string | null;
}

/** Knowledge 应用服务；答案、标准答案、题库引用与提交引用均不进入响应或事件。 */
@Injectable()
export class KnowledgeApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly courses: CourseVersionRepository,
    private readonly assignments: TrainingAssignmentRepository,
    private readonly attempts: ExamAttemptRepository,
    private readonly evidence: KnowledgeEvidenceRepository,
    private readonly outbox: KnowledgeOutboxWriter,
    private readonly searchIndexTasks: KnowledgeSearchIndexTaskWriter,
    private readonly grader: KnowledgeGradingPort,
    private readonly verifier: KnowledgeContentVerificationPort,
    private readonly searcher: KnowledgeSearchPort,
    private readonly onboarding: OnboardingApplicationService,
    private readonly profiles: AccessProfileRepository,
    private readonly employments: EmploymentRepository,
    private readonly employees: EmployeeRepository,
  ) {}

  async createCourse(
    key: string,
    input: {
      readonly courseCode: string;
      readonly revision: number;
      readonly title: string;
      readonly contentRef: string;
      readonly questionBankRef?: string;
      readonly questionBankDigest?: string;
      readonly passingScoreBps?: number;
      readonly questionMode?: 'objective' | 'subjective' | 'mixed';
      readonly timeLimitMinutes?: number;
      readonly maxAttempts?: number;
      readonly gradingPolicyVersion?: string;
      readonly passingRule?: 'score_threshold' | 'all_required_sections';
      readonly gradingSlaMinutes?: number;
      readonly manualReviewSlaMinutes?: number;
      readonly audienceMode?: 'assigned_only' | 'employment_scope';
      readonly audienceDepartmentIds?: readonly string[];
      readonly audiencePositionIds?: readonly string[];
    },
  ): Promise<{ readonly course: CourseSummary }> {
    this.assertScope('erp:knowledge:course:create');
    return this.run(async () => this.idempotency.execute(
      'knowledge.course.create', key, input, async (session) => {
        const now = new Date();
        const course = createCourseVersion({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId, ...input,
        }, now);
        await this.courses.insert(course, session);
        await this.outbox.append(courseEvent(course, 'knowledge.course.created'), session);
        return { course: courseSummary(course) };
      },
    ));
  }

  async publishCourse(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly course: CourseSummary }> {
    this.assertScope('erp:knowledge:course:publish');
    const current = await this.requireCourse(id);
    const verification = await this.verifier.verify(current);
    return this.run(async () => this.idempotency.execute(
      'knowledge.course.publish', key, { id, expectedVersion }, async (session) => {
        const fresh = await this.requireCourse(id, session);
        const course = publishCourseVersion(fresh, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          contentVerified: verification.contentVerified,
          questionBankVerified: verification.questionBankVerified,
        }, new Date());
        await this.courses.replace(course, expectedVersion, session);
        const eventId = await this.outbox.append(
          courseEvent(course, 'knowledge.course.published'),
          session,
        );
        await this.searchIndexTasks.append(eventId, course, 'upsert', session);
        return { course: courseSummary(course) };
      },
    ));
  }

  async getCourse(id: string): Promise<CourseSummary> {
    this.assertScope('erp:knowledge:course:read');
    return courseSummary(await this.requireCourse(id));
  }

  async retireCourse(
    id: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly course: CourseSummary }> {
    this.assertScope('erp:knowledge:course:publish');
    return this.run(async () => this.idempotency.execute(
      'knowledge.course.retire',
      key,
      { id, expectedVersion },
      async (session) => {
        const current = await this.requireCourse(id, session);
        const course = retireCourseVersion(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
        }, new Date());
        await this.courses.replace(course, expectedVersion, session);
        const eventId = await this.outbox.append(
          courseEvent(course, 'knowledge.course.retired'),
          session,
        );
        await this.searchIndexTasks.append(eventId, course, 'delete', session);
        return { course: courseSummary(course) };
      },
    ));
  }

  async assignCourse(
    onboardingInstanceId: string,
    key: string,
    input: { readonly courseVersionId: string; readonly mandatory: boolean; readonly dueDate: string },
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    this.assertScope('erp:knowledge:assignment:create');
    await this.onboarding.get(onboardingInstanceId);
    return this.run(async () => this.idempotency.execute(
      'knowledge.assignment.create', key, { onboardingInstanceId, ...input }, async (session) => {
        if (input.mandatory && await this.evidence.findAttestation(onboardingInstanceId, session) !== null) {
          throw new ConflictException({
            code: 'KNOWLEDGE_ONBOARDING_ALREADY_ATTESTED',
            message: '培训证明形成后不能追加必修任务',
          });
        }
        const course = await this.requireCourse(input.courseVersionId, session);
        const now = new Date();
        const assignment = createTrainingAssignment({
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          onboardingInstanceId, courseVersionId: course.id, mandatory: input.mandatory,
          examRequired: course.questionBankRef !== null, dueDate: input.dueDate,
          coursePublished: course.status === 'published',
        }, now);
        await this.assignments.insert(assignment, session);
        await this.outbox.append(assignmentEvent(assignment, 'knowledge.assignment.created'), session);
        return { assignment: assignmentSummary(assignment) };
      },
    ));
  }

  async getAssignment(id: string): Promise<TrainingAssignmentSummary> {
    this.assertScope('erp:knowledge:assignment:read');
    const assignment = await this.requireAssignment(id);
    await this.onboarding.get(assignment.onboardingInstanceId);
    return assignmentSummary(assignment);
  }

  async listOnboardingAssignments(
    onboardingInstanceId: string,
  ): Promise<{ readonly items: readonly TrainingAssignmentSummary[] }> {
    this.assertScope('erp:knowledge:assignment:read');
    await this.onboarding.get(onboardingInstanceId);
    const items = await this.assignments.findByOnboarding(onboardingInstanceId);
    return { items: items.map(assignmentSummary) };
  }

  /** 当前员工培训任务；主体到员工、任职与入职实例的映射只取服务端可信主数据。 */
  async listMyAssignments(): Promise<{ readonly items: readonly PersonalTrainingAssignmentView[] }> {
    this.assertScope('erp:knowledge:assignment:read');
    const { employment } = await this.resolveEmployeeContext();
    const assignments = await this.assignments.findByOnboarding(employment.onboardingInstanceId);
    const courses = await this.courses.findByIds(
      [...new Set(assignments.map((item) => item.courseVersionId))],
    );
    const courseById = new Map(courses.map((course) => [course.id, course]));
    const items = assignments.map((assignment) => {
      const course = courseById.get(assignment.courseVersionId);
      if (course === undefined) throw new NotFoundException({
        code: 'KNOWLEDGE_COURSE_NOT_FOUND', message: '培训任务引用的课程版本不存在',
      });
      return Object.freeze({
        id: assignment.id,
        course: courseSummary(course),
        mandatory: assignment.mandatory,
        examRequired: assignment.examRequired,
        dueDate: assignment.dueDate,
        status: assignment.status,
        progressBps: assignment.progressBps,
        version: assignment.version,
      });
    }).sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id));
    return Object.freeze({ items: Object.freeze(items) });
  }

  /** 当前员工知识全文检索；网关粗筛后仍按当前任务与课程状态逐项失败关闭。 */
  async searchMyKnowledge(input: {
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<PersonalKnowledgeSearchResult> {
    this.assertScope('erp:knowledge:search');
    const queryText = normalizeSearchQuery(input.query);
    const cursor = normalizeSearchCursor(input.cursor);
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new BadRequestException({
        code: 'KNOWLEDGE_SEARCH_LIMIT_INVALID', message: 'limit 必须为 1..20 的整数',
      });
    }
    const { profile, employment, employee, departmentIds } =
      await this.resolveEmployeeContext();
    const assignments = await this.assignments.findByOnboarding(employment.onboardingInstanceId);
    const assignedCourseIds = [...new Set(assignments
      .filter((item) => item.status !== 'expired')
      .map((item) => item.courseVersionId))].sort();
    const positionIds = [...employee.positionIds].sort();
    const candidates = await this.courses.findSearchEligible(
      assignedCourseIds,
      departmentIds,
      positionIds,
    );
    const eligible = currentPublishedCourseVersions(candidates);
    if (eligible.length === 0) {
      return Object.freeze({ items: Object.freeze([]), nextCursor: null });
    }
    const eligibleById = new Map(eligible.map((course) => [course.id, course]));
    const authorizationDigest = createHash('sha256').update(JSON.stringify([
      profile.version,
      employment.id,
      employment.version,
      employee.id,
      employee.version,
      departmentIds,
      positionIds,
      eligible.map((course) => [course.id, course.version]),
    ]), 'utf8').digest('base64url');
    const result = await this.searcher.search({
      tenantId: this.context.getTenantRequired().tenantId,
      employeeId: employee.id,
      departmentIds,
      positionIds,
      allowedCourseVersionIds: eligible.map((course) => course.id).sort(),
      authorizationDigest,
      queryText,
      cursor,
      limit,
    });
    const items = result.items.map((item) => {
      const course = eligibleById.get(item.courseVersionId);
      if (course === undefined || course.revision !== item.revision) {
        throw new BadGatewayException({
          code: 'KNOWLEDGE_SEARCH_AUTHORIZATION_MISMATCH',
          message: '搜索结果与当前课程授权不一致',
        });
      }
      const indexedAt = new Date(item.indexedAt);
      const courseUpdatedAt = new Date(course.updatedAt);
      if (
        Number.isNaN(indexedAt.getTime()) ||
        indexedAt.getTime() < courseUpdatedAt.getTime() ||
        indexedAt.getTime() > Date.now() + 5 * 60_000
      ) throw new BadGatewayException({
        code: 'KNOWLEDGE_SEARCH_INDEX_FRESHNESS_INVALID',
        message: '搜索结果索引时间不满足当前课程版本',
      });
      return Object.freeze({
        course: courseSummary(course),
        snippetText: item.snippetText,
        highlights: item.highlights,
        scoreBps: item.scoreBps,
        indexedAt: item.indexedAt,
      });
    });
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: result.nextCursor,
    });
  }

  /** LMS/内容播放器专用：只接受可信源绝对进度与唯一源事件。 */
  async recordProgressForIntegration(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly source: string;
      readonly sourceEventId: string;
      readonly progressBps: number;
      readonly occurredAt: string;
    },
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    this.assertScope('erp:integration:knowledge:progress');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.source)) throw new BadRequestException({
      code: 'KNOWLEDGE_PROGRESS_SOURCE_INVALID', message: '进度来源非法',
    });
    return this.run(async () => this.idempotency.execute(
      'knowledge.assignment.record_progress', key, { id, expectedVersion, ...input },
      async (session) => {
        const existing = await this.evidence.findProgressEvent(
          input.source, input.sourceEventId, session,
        );
        if (existing !== null) {
          if (existing.assignmentId !== id || existing.progressBps !== input.progressBps) {
            throw new ConflictException({
              code: 'KNOWLEDGE_PROGRESS_EVENT_REUSED', message: '进度源事件已绑定不同事实',
            });
          }
          return { assignment: assignmentSummary(await this.requireAssignment(id, session)) };
        }
        const current = await this.requireAssignment(id, session);
        const occurredAt = requiredDate(input.occurredAt);
        if (
          occurredAt.getTime() < Date.parse(current.updatedAt) ||
          occurredAt.getTime() > Date.now() + 5 * 60 * 1_000
        ) throw new ConflictException({
          code: 'KNOWLEDGE_PROGRESS_TIME_INVALID', message: '进度事件时间乱序或超前',
        });
        const assignment = recordTrainingProgress(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion, progressBps: input.progressBps,
        }, occurredAt);
        await this.assignments.replace(assignment, expectedVersion, session);
        await this.evidence.appendProgress({
          id: createEventId(occurredAt), tenantId: assignment.tenantId,
          assignmentId: assignment.id, ...input,
        }, session);
        await this.outbox.append(
          assignmentEvent(assignment, 'knowledge.assignment.progressed'), session,
        );
        return { assignment: assignmentSummary(assignment) };
      },
    ));
  }

  /** 评分器必须按 submissionRef 幂等，且只返回分数与不可变证据摘要。 */
  async gradeExam(
    assignmentId: string,
    key: string,
    submissionRef: string,
  ): Promise<{ readonly attempt: ExamAttemptSummary }> {
    this.assertScope('erp:knowledge:exam:grade');
    const assignment = await this.requireAssignment(assignmentId);
    if (assignment.status === 'completed' || assignment.status === 'expired') {
      throw new ConflictException({
        code: 'KNOWLEDGE_ASSIGNMENT_TERMINAL', message: '终态培训任务不能继续考试',
      });
    }
    const existingAttempt = await this.attempts.findBySubmissionRef(submissionRef);
    if (existingAttempt !== null) {
      if (existingAttempt.assignmentId !== assignmentId) throw new ConflictException({
        code: 'KNOWLEDGE_SUBMISSION_REUSED', message: '答卷提交引用已绑定其他培训任务',
      });
      return { attempt: attemptSummary(existingAttempt) };
    }
    const course = await this.requireCourse(assignment.courseVersionId);
    const maxAttempts = course.maxAttempts;
    const questionMode = course.questionMode;
    if (
      !assignment.examRequired || course.questionBankRef === null ||
      course.questionBankDigest === null || course.passingScoreBps === null ||
      maxAttempts === null || questionMode === null
    ) throw new ConflictException({
      code: 'KNOWLEDGE_EXAM_NOT_CONFIGURED', message: '该培训任务未配置考试',
    });
    if (questionMode !== 'objective' || course.manualReviewRequired) {
      throw new ConflictException({
        code: 'KNOWLEDGE_EXAM_RUN_REQUIRED',
        message: '主观题或混合题必须使用可靠考试运行流程',
      });
    }
    if (await this.attempts.countByAssignment(assignmentId) >= maxAttempts) {
      throw new ConflictException({
        code: 'KNOWLEDGE_EXAM_ATTEMPTS_EXHAUSTED', message: '已达到课程最大考试次数',
      });
    }
    const graded = await this.grader.grade({
      tenantId: this.context.getTenantRequired().tenantId,
      assignmentId, courseVersionId: course.id,
      questionBankRef: course.questionBankRef,
      questionBankDigest: course.questionBankDigest,
      submissionRef,
    });
    if (graded.questionBankDigest !== course.questionBankDigest) throw new ConflictException({
      code: 'KNOWLEDGE_QUESTION_BANK_DIGEST_MISMATCH', message: '评分题库版本不匹配',
    });
    return this.run(async () => this.idempotency.execute(
      'knowledge.exam.grade', key, { assignmentId, submissionRef }, async (session) => {
        const replay = await this.attempts.findBySubmissionRef(submissionRef, session);
        if (replay !== null) {
          if (replay.assignmentId !== assignmentId) throw new ConflictException({
            code: 'KNOWLEDGE_SUBMISSION_REUSED', message: '答卷提交引用已绑定其他培训任务',
          });
          return { attempt: attemptSummary(replay) };
        }
        const freshAssignment = await this.requireAssignment(assignmentId, session);
        if (freshAssignment.status === 'completed' || freshAssignment.status === 'expired') {
          throw new ConflictException({
            code: 'KNOWLEDGE_ASSIGNMENT_TERMINAL', message: '终态培训任务不能继续考试',
          });
        }
        if (freshAssignment.courseVersionId !== course.id) throw new ConflictException({
          code: 'KNOWLEDGE_ASSIGNMENT_COURSE_CHANGED', message: '培训任务课程引用已变化',
        });
        const attemptNumber = await this.attempts.nextAttemptNumber(assignmentId, session);
        if (attemptNumber > maxAttempts) throw new ConflictException({
          code: 'KNOWLEDGE_EXAM_ATTEMPTS_EXHAUSTED', message: '已达到课程最大考试次数',
        });
        const attempt = createExamAttempt({
          id: createEventId(new Date()), tenantId: freshAssignment.tenantId,
          assignmentId, attemptNumber,
          submissionRef, questionSetDigest: graded.questionSetDigest,
          gradingEvidenceId: graded.gradingEvidenceId, scoreBps: graded.scoreBps,
          questionMode,
          gradingPolicyVersion: course.gradingPolicyVersion ?? 'objective-auto-v1',
          passingRule: course.passingRule ?? 'score_threshold',
          passingScoreBps: course.passingScoreBps ?? 0, serverGradingVerified: true,
        }, new Date());
        await this.attempts.insert(attempt, session);
        await this.outbox.append(examGradedEvent(attempt), session);
        return { attempt: attemptSummary(attempt) };
      },
    ));
  }

  async completeAssignment(
    id: string,
    expectedVersion: number,
    key: string,
    passedExamAttemptId?: string,
  ): Promise<{ readonly assignment: TrainingAssignmentSummary }> {
    this.assertScope('erp:knowledge:assignment:complete');
    const currentSnapshot = await this.requireAssignment(id);
    const result = currentSnapshot.status === 'completed'
      ? { assignment: assignmentSummary(this.assertCompletedReplay(
        currentSnapshot, expectedVersion, passedExamAttemptId,
      )) }
      : await this.run(async () => this.idempotency.execute(
        'knowledge.assignment.complete', key,
        { id, expectedVersion, passedExamAttemptId: passedExamAttemptId ?? null },
        async (session) => {
        const current = await this.requireAssignment(id, session);
        let examPassedVerified = false;
        if (current.examRequired) {
          if (passedExamAttemptId === undefined) throw new ConflictException({
            code: 'KNOWLEDGE_PASSED_EXAM_REQUIRED', message: '考试课程必须引用已通过尝试',
          });
          const attempt = await this.attempts.findById(passedExamAttemptId, session);
          examPassedVerified = attempt !== null && attempt.assignmentId === id && attempt.passed;
        }
        const assignment = completeTrainingAssignment(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion, completionEvidenceId: createEventId(new Date()),
          ...(passedExamAttemptId === undefined ? {} : { passedExamAttemptId }),
          examPassedVerified,
        }, new Date());
        await this.assignments.replace(assignment, expectedVersion, session);
        await this.outbox.append(
          assignmentEvent(assignment, 'knowledge.assignment.completed'), session,
        );
        return { assignment: assignmentSummary(assignment) };
        },
      ));
    await this.attestOnboardingIfReady(result.assignment.onboardingInstanceId, key);
    return result;
  }

  private assertCompletedReplay(
    assignment: TrainingAssignment,
    expectedVersion: number,
    passedExamAttemptId?: string,
  ): TrainingAssignment {
    if (assignment.version !== expectedVersion) throw new ConflictException({
      code: 'KNOWLEDGE_VERSION_CONFLICT', message: '培训任务版本冲突',
    });
    if (
      assignment.examRequired &&
      (passedExamAttemptId === undefined || passedExamAttemptId !== assignment.passedExamAttemptId)
    ) throw new ConflictException({
      code: 'KNOWLEDGE_PASSED_EXAM_MISMATCH', message: '已完成任务的通过考试引用不一致',
    });
    return assignment;
  }

  private async attestOnboardingIfReady(onboardingInstanceId: string, rootKey: string): Promise<void> {
    const assignments = await this.assignments.findByOnboarding(onboardingInstanceId);
    const mandatory = assignments.filter((item) => item.mandatory);
    if (
      mandatory.length === 0 ||
      mandatory.some((item) => item.status !== 'completed' || item.completionEvidenceId === null)
    ) return;
    const facts = mandatory.map((item) => [item.id, item.completionEvidenceId]).sort();
    const digest = createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('base64url');
    const attestation = await this.idempotency.execute(
      'knowledge.onboarding.attest', deriveKey(rootKey, 'attest'),
      { onboardingInstanceId, digest }, async (session) => {
        const existing = await this.evidence.findAttestation(onboardingInstanceId, session);
        if (existing !== null) {
          if (existing.digest !== digest) throw new ConflictException({
            code: 'KNOWLEDGE_ONBOARDING_ATTESTATION_CHANGED',
            message: '入职培训证明形成后必修任务集合发生变化',
          });
          return { attestationId: existing.id };
        }
        const now = new Date();
        const record = {
          id: createEventId(now), tenantId: this.context.getTenantRequired().tenantId,
          onboardingInstanceId, digest, assignmentCount: mandatory.length,
          attestedAt: now.toISOString(),
        };
        await this.evidence.insertAttestation(record, session);
        await this.outbox.append(onboardingAttestedEvent(record), session);
        return { attestationId: record.id };
      },
    );
    const onboarding = await this.onboarding.get(onboardingInstanceId);
    await this.onboarding.recordTaskEvidence(
      onboardingInstanceId, onboarding.version, deriveKey(rootKey, 'onboarding-evidence'),
      { taskCode: 'mandatory_training_completed', evidenceId: attestation.attestationId },
    );
  }

  private async requireCourse(id: string, session?: Parameters<CourseVersionRepository['findById']>[1]) {
    const value = await this.courses.findById(id, session);
    if (value === null) throw new NotFoundException({ code: 'KNOWLEDGE_COURSE_NOT_FOUND', message: '课程版本不存在' });
    return value;
  }

  private async requireAssignment(id: string, session?: Parameters<TrainingAssignmentRepository['findById']>[1]) {
    const value = await this.assignments.findById(id, session);
    if (value === null) throw new NotFoundException({ code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND', message: '培训任务不存在' });
    return value;
  }

  private async resolveEmployeeContext(): Promise<{
    readonly profile: AccessProfileSnapshot;
    readonly employment: Employment;
    readonly employee: Employee;
    readonly departmentIds: readonly string[];
  }> {
    const actor = this.context.getActorRequired();
    const tenantId = this.context.getTenantRequired().tenantId;
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED', message: '当前主体不是员工用户',
    });
    const profile = await this.profiles.resolveActive(tenantId, actor.actorId);
    if (profile === null || profile.actorId !== actor.actorId) throw new ForbiddenException({
      code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED', message: '当前主体没有有效员工授权快照',
    });
    const [employment, employee] = await Promise.all([
      this.employments.findOpenByEmployeeId(profile.employeeId),
      this.employees.findById(profile.employeeId),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    if (
      employment === null || employment.employeeId !== profile.employeeId ||
      !['probation', 'active'].includes(employment.status) ||
      employment.effectiveFrom > today ||
      employee === null || employee.id !== profile.employeeId ||
      !['probation', 'active'].includes(employee.status)
    ) throw new ForbiddenException({
      code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED', message: '当前主体没有有效任职关系',
    });
    const employeeDepartments = new Set(employee.departmentIds);
    const departmentIds = [...new Set(profile.departmentIds)]
      .filter((departmentId) => employeeDepartments.has(departmentId))
      .sort();
    if (departmentIds.length === 0) throw new ForbiddenException({
      code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED', message: '授权快照与员工部门不一致',
    });
    return Object.freeze({
      profile,
      employment,
      employee,
      departmentIds: Object.freeze(departmentIds),
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'KNOWLEDGE_SCOPE_REQUIRED', message: `缺少 ${scope}`,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof KnowledgeWriteConflictError) throw new ConflictException({
        code: 'KNOWLEDGE_VERSION_CONFLICT', message: error.message,
      });
      if (error instanceof KnowledgeDomainError) {
        if (error.code.includes('TENANT')) throw new ForbiddenException({ code: error.code, message: error.message });
        if (
          error.code.includes('VERSION') || error.code.includes('TERMINAL') ||
          error.code.includes('REGRESSION') || error.code.includes('INCOMPLETE') ||
          error.code.includes('REQUIRED') || error.code.includes('UNEXPECTED')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'KNOWLEDGE_UNIQUE_CONFLICT', message: '课程、任务或证据已存在',
      });
      throw error;
    }
  }
}

function courseSummary(course: CourseVersion): CourseSummary {
  return Object.freeze({
    id: course.id, courseCode: course.courseCode, revision: course.revision,
    title: course.title, examRequired: course.questionBankRef !== null,
    passingScoreBps: course.passingScoreBps,
    questionMode: course.questionMode,
    timeLimitMinutes: course.timeLimitMinutes,
    maxAttempts: course.maxAttempts,
    gradingPolicyVersion: course.gradingPolicyVersion,
    passingRule: course.passingRule,
    gradingSlaMinutes: course.gradingSlaMinutes,
    manualReviewSlaMinutes: course.manualReviewSlaMinutes,
    manualReviewRequired: course.manualReviewRequired,
    status: course.status,
    version: course.version,
  });
}

function assignmentSummary(value: TrainingAssignment): TrainingAssignmentSummary {
  return Object.freeze({
    id: value.id, onboardingInstanceId: value.onboardingInstanceId,
    courseVersionId: value.courseVersionId, mandatory: value.mandatory,
    examRequired: value.examRequired, dueDate: value.dueDate, status: value.status,
    progressBps: value.progressBps, version: value.version,
  });
}

function attemptSummary(value: ExamAttempt): ExamAttemptSummary {
  return Object.freeze({
    id: value.id, assignmentId: value.assignmentId, attemptNumber: value.attemptNumber,
    scoreBps: value.scoreBps, passed: value.passed, gradedAt: value.gradedAt,
  });
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `knowledge:${digest}`;
}

function requiredDate(value: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new BadRequestException({
    code: 'KNOWLEDGE_DATE_INVALID', message: '时间格式非法',
  });
  return result;
}

function normalizeSearchQuery(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (
    normalized.length < 2 ||
    normalized.length > 128 ||
    !/^[\p{L}\p{M}\p{N}\s._-]+$/u.test(normalized)
  ) throw new BadRequestException({
    code: 'KNOWLEDGE_SEARCH_QUERY_INVALID',
    message: '查询必须为 2..128 个中英文、数字、空格或 ._- 字符',
  });
  return normalized;
}

function normalizeSearchCursor(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(value)) throw new BadRequestException({
    code: 'KNOWLEDGE_SEARCH_CURSOR_INVALID', message: '搜索游标非法',
  });
  return value;
}

function currentPublishedCourseVersions(
  courses: readonly CourseVersion[],
): readonly CourseVersion[] {
  const current = new Map<string, CourseVersion>();
  for (const course of courses) {
    const previous = current.get(course.courseCode);
    if (
      previous === undefined ||
      course.revision > previous.revision ||
      (course.revision === previous.revision && course.id.localeCompare(previous.id) < 0)
    ) current.set(course.courseCode, course);
  }
  return Object.freeze([...current.values()].sort((left, right) =>
    left.courseCode.localeCompare(right.courseCode) ||
    right.revision - left.revision ||
    left.id.localeCompare(right.id)));
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
