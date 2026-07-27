import {
  BadRequestException,
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
import { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import {
  buildRecruitmentInterviewEvent,
  buildRecruitmentInterviewFeedbackEvent,
  buildRecruitmentInterviewMigratedEvent,
  cancelRecruitmentInterview,
  completeRecruitmentInterview,
  createRecruitmentInterview,
  RecruitmentDomainError,
  restoreRecruitmentInterviewFromMigration,
  submitRecruitmentInterviewFeedback,
  type InterviewRecommendation,
  type RecruitmentInterview,
  type RecruitmentInterviewMode,
  type RecruitmentInterviewMigrationFeedback,
  type RecruitmentInterviewStatus,
} from '../domain/index.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  CandidateApplicationRepository,
  RecruitmentInterviewFeedbackRepository,
  RecruitmentInterviewRepository,
  RecruitmentPositionRepository,
  RecruitmentWriteConflictError,
} from '../persistence/recruitment.repositories.js';

export interface RecruitmentInterviewSummary extends Record<string, unknown> {
  readonly id: string;
  readonly applicationId: string;
  readonly roundNumber: number;
  readonly mode: RecruitmentInterviewMode;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly interviewerIds: readonly string[];
  readonly status: RecruitmentInterviewStatus;
  readonly version: number;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

export interface RecruitmentFeedbackReceipt extends Record<string, unknown> {
  readonly id: string;
  readonly interviewId: string;
  readonly interviewerId: string;
  readonly submittedAt: string;
}

export interface ImportRecruitmentInterviewFromMigrationInput {
  readonly targetId: string | null;
  readonly applicationId: string;
  readonly roundNumber: number;
  readonly mode: RecruitmentInterviewMode;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly interviewerIds: readonly string[];
  readonly location: string;
  readonly createdByEmployeeId: string;
  readonly feedback: readonly Omit<RecruitmentInterviewMigrationFeedback, 'id'>[];
  readonly expectedStatus: RecruitmentInterviewStatus;
  readonly expectedVersion: number;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

/** Integration Worker 专用投影；不得从 REST 或 MCP 直接返回。 */
export interface RecruitmentCalendarProjection {
  readonly interviewId: string;
  readonly applicationId: string;
  readonly version: number;
  readonly status: RecruitmentInterviewStatus;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly interviewerIds: readonly string[];
  readonly location: string;
}

/** 面试应用服务；面试官身份必须由 actor 的有效权限快照解析为 ERP 员工。 */
@Injectable()
export class RecruitmentInterviewService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly employees: EmployeeRepository,
    private readonly applications: CandidateApplicationRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly interviews: RecruitmentInterviewRepository,
    private readonly feedback: RecruitmentInterviewFeedbackRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  /** 数据迁移专用：L3 地点和评价仅在内存中回放并进入现有加密仓储。 */
  async importInterviewFromMigration(
    key: string,
    input: ImportRecruitmentInterviewFromMigrationInput,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    this.assertMigrationWriter();
    assertInterviewMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    return this.run(async () => this.idempotency.execute(
      'recruitment.interview.import_from_migration', key, input, async (session) => {
        const application = await this.requireApplication(input.applicationId, session);
        if (application.stage !== 'interview') throw new BadRequestException({
          code: 'RECRUITMENT_MIGRATION_INTERVIEW_APPLICATION_INVALID',
          message: '面试迁移必须引用处于面试基线的申请',
        });
        const employeeIds = [...new Set([
          input.createdByEmployeeId,
          ...input.interviewerIds,
        ])];
        const employeeRecords = await Promise.all(employeeIds.map(async (id) => ({
          id,
          employee: await this.employees.findById(id, session),
        })));
        if (employeeRecords.some((item) => item.employee === null) ||
          (input.expectedStatus === 'scheduled' && employeeRecords
            .filter((item) => input.interviewerIds.includes(item.id))
            .some((item) => !['probation', 'active'].includes(item.employee?.status ?? '')))) {
          throw new BadRequestException({
            code: 'RECRUITMENT_MIGRATION_INTERVIEW_EMPLOYEE_INVALID',
            message: '面试迁移引用的创建员工或面试官无效',
          });
        }
        const existingFeedback = input.targetId === null
          ? []
          : await this.feedback.findByInterview(input.targetId, session);
        const feedbackByInterviewer = new Map(
          existingFeedback.map((item) => [item.interviewerId, item] as const),
        );
        const restored = restoreRecruitmentInterviewFromMigration({
          ...input,
          id: input.targetId ?? createEventId(new Date(input.createdAt)),
          tenantId: this.context.getTenantRequired().tenantId,
          createdBy: input.createdByEmployeeId,
          feedback: input.feedback.map((item) => ({
            ...item,
            id: feedbackByInterviewer.get(item.interviewerId)?.id ??
              createEventId(new Date(item.submittedAt)),
          })),
        }, new Date());
        if (input.targetId !== null) {
          const [existing, evidence] = await Promise.all([
            this.interviews.findById(input.targetId, session),
            this.interviews.findMigrationEvidenceById(input.targetId, session),
          ]);
          if (existing === null || evidence === null ||
            !sameMigratedInterview(existing, restored.interview) ||
            !sameMigratedFeedback(existingFeedback, restored.feedback) ||
            evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            evidence.migrationEvidenceChecksum !== input.evidenceChecksum) {
            throw new ConflictException({
              code: 'RECRUITMENT_MIGRATION_INTERVIEW_IMMUTABLE',
              message: '既有面试与迁移快照、评价或 WORM 证据不一致，禁止覆盖',
            });
          }
          return { interview: interviewSummary(existing) };
        }
        await this.interviews.insertMigrated(
          restored.interview,
          input.migrationEvidenceRef,
          input.evidenceChecksum,
          session,
        );
        for (const item of restored.feedback) await this.feedback.append(item, session);
        await this.outbox.append(
          buildRecruitmentInterviewMigratedEvent(restored.interview), session,
        );
        return { interview: interviewSummary(restored.interview) };
      },
    ));
  }

  async schedule(
    applicationId: string,
    expectedApplicationVersion: number,
    key: string,
    input: {
      readonly roundNumber: number;
      readonly mode: RecruitmentInterviewMode;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly timezone: string;
      readonly interviewerIds: readonly string[];
      readonly location: string;
    },
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.interview.schedule', key,
      { applicationId, expectedApplicationVersion, ...input }, async (session) => {
        const application = await this.requireApplication(applicationId, session);
        if (application.version !== expectedApplicationVersion) throw new RecruitmentDomainError(
          'RECRUITMENT_VERSION_CONFLICT', '候选申请版本冲突',
        );
        if (application.stage !== 'interview') throw new ConflictException({
          code: 'RECRUITMENT_APPLICATION_NOT_INTERVIEWING', message: '申请未进入面试阶段',
        });
        const position = await this.positions.findById(application.positionId, session);
        if (position === null) throw new Error('RECRUITMENT_POSITION_REFERENCE_INVALID');
        this.assertDepartmentWrite(position.departmentId);
        for (const interviewerId of input.interviewerIds) {
          const employee = await this.employees.findById(interviewerId, session);
          if (employee === null || !['probation', 'active'].includes(employee.status)) {
            throw new BadRequestException({
              code: 'RECRUITMENT_INTERVIEWER_INACTIVE', message: '面试官必须是 ERP 当前有效员工',
            });
          }
        }
        const trusted = this.context.getRequired();
        const now = new Date();
        const interview = createRecruitmentInterview({
          id: createEventId(now), tenantId: trusted.tenant.tenantId, applicationId,
          actorId: trusted.actor.actorId, roundNumber: input.roundNumber, mode: input.mode,
          startsAt: requiredDate(input.startsAt), endsAt: requiredDate(input.endsAt),
          timezone: input.timezone, interviewerIds: input.interviewerIds,
          location: input.location,
        }, now);
        await this.interviews.insert(interview, session);
        await this.outbox.append(buildRecruitmentInterviewEvent(interview, 'scheduled'), session);
        return { interview: interviewSummary(interview) };
      },
    ));
  }

  async submitFeedback(
    interviewId: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly recommendation: InterviewRecommendation;
      readonly score: number;
      readonly notes: string;
    },
  ): Promise<{ readonly feedback: RecruitmentFeedbackReceipt }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.interview.feedback.submit', key, { interviewId, expectedVersion, ...input },
      async (session) => {
        const trusted = this.context.getRequired();
        const profile = await this.profiles.resolveActive(
          trusted.tenant.tenantId, trusted.actor.actorId, session,
        );
        if (profile === null) throw new ForbiddenException({
          code: 'RECRUITMENT_INTERVIEWER_IDENTITY_INVALID', message: '无法将当前主体解析为有效 ERP 员工',
        });
        const employee = await this.employees.findById(profile.employeeId, session);
        if (employee === null || !['probation', 'active'].includes(employee.status)) {
          throw new ForbiddenException({
            code: 'RECRUITMENT_INTERVIEWER_INACTIVE', message: '当前面试官已失效',
          });
        }
        const interview = await this.requireInterview(interviewId, session);
        const now = new Date();
        const result = submitRecruitmentInterviewFeedback(interview, {
          id: createEventId(now), tenantId: trusted.tenant.tenantId,
          expectedVersion, interviewerId: profile.employeeId, ...input,
        }, now);
        await this.feedback.append(result.feedback, session);
        await this.interviews.replace(result.interview, expectedVersion, session);
        await this.outbox.append(buildRecruitmentInterviewFeedbackEvent(
          result.interview, result.feedback,
        ), session);
        return { feedback: feedbackReceipt(result.feedback) };
      },
    ));
  }

  async complete(
    interviewId: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('complete', interviewId, expectedVersion, key);
  }

  async cancel(
    interviewId: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.transition('cancel', interviewId, expectedVersion, key);
  }

  async get(interviewId: string): Promise<RecruitmentInterviewSummary> {
    const interview = await this.requireInterview(interviewId);
    const application = await this.requireApplication(interview.applicationId);
    const position = await this.positions.findById(application.positionId);
    if (position === null) throw new Error('RECRUITMENT_POSITION_REFERENCE_INVALID');
    const actor = this.context.getActorRequired();
    const profile = await this.profiles.resolveActive(
      this.context.getTenantRequired().tenantId, actor.actorId,
    );
    const assigned = profile !== null && interview.interviewerIds.includes(profile.employeeId);
    if (
      !assigned && !actor.scopes.includes('erp:recruitment:interview:read_all') &&
      !actor.departmentIds.includes(position.departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_INTERVIEW_READ_DENIED', message: '无权读取该面试',
    });
    return interviewSummary(interview);
  }

  async getCalendarProjectionForIntegration(
    interviewId: string,
  ): Promise<RecruitmentCalendarProjection> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'system_job' ||
      !actor.scopes.includes('erp:integration:calendar:deliver')
    ) {
      throw new ForbiddenException({
        code: 'RECRUITMENT_CALENDAR_PROJECTION_DENIED', message: '无权读取日历投影',
      });
    }
    const interview = await this.requireInterview(interviewId);
    return Object.freeze({
      interviewId: interview.id, applicationId: interview.applicationId,
      version: interview.version, status: interview.status,
      startsAt: interview.startsAt, endsAt: interview.endsAt, timezone: interview.timezone,
      interviewerIds: Object.freeze([...interview.interviewerIds]), location: interview.location,
    });
  }

  private async transition(
    action: 'complete' | 'cancel',
    interviewId: string,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly interview: RecruitmentInterviewSummary }> {
    return this.run(async () => this.idempotency.execute(
      `recruitment.interview.${action}`, key, { interviewId, expectedVersion },
      async (session) => {
        const current = await this.requireInterview(interviewId, session);
        const application = await this.requireApplication(current.applicationId, session);
        const position = await this.positions.findById(application.positionId, session);
        if (position === null) throw new Error('RECRUITMENT_POSITION_REFERENCE_INVALID');
        this.assertDepartmentWrite(position.departmentId);
        const now = new Date();
        const interview = action === 'complete'
          ? completeRecruitmentInterview(current, {
              tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
              submittedInterviewerIds: await this.feedback.findInterviewerIds(interviewId, session),
            }, now)
          : cancelRecruitmentInterview(current, {
              tenantId: this.context.getTenantRequired().tenantId, expectedVersion,
            }, now);
        await this.interviews.replace(interview, expectedVersion, session);
        await this.outbox.append(buildRecruitmentInterviewEvent(
          interview, action === 'complete' ? 'completed' : 'cancelled',
        ), session);
        return { interview: interviewSummary(interview) };
      },
    ));
  }

  private async requireApplication(id: string, session?: ClientSession) {
    const application = await this.applications.findById(id, session);
    if (application === null) throw new NotFoundException({
      code: 'RECRUITMENT_APPLICATION_NOT_FOUND', message: '候选申请不存在',
    });
    return application;
  }

  private async requireInterview(id: string, session?: ClientSession): Promise<RecruitmentInterview> {
    const interview = await this.interviews.findById(id, session);
    if (interview === null) throw new NotFoundException({
      code: 'RECRUITMENT_INTERVIEW_NOT_FOUND', message: '面试不存在',
    });
    return interview;
  }

  private assertDepartmentWrite(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:management:write_all') &&
      !actor.departmentIds.includes(departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_INTERVIEW_WRITE_DENIED', message: '无权修改该部门面试',
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:recruitment:migration:write')) {
      throw new ForbiddenException({
        code: 'RECRUITMENT_MIGRATION_WRITER_DENIED',
        message: '面试迁移必须由受信任服务身份执行',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RecruitmentWriteConflictError) throw new ConflictException({
        code: 'RECRUITMENT_VERSION_CONFLICT', message: error.message,
      });
      if (error instanceof RecruitmentDomainError) {
        if (error.code.includes('DENIED') || error.code.includes('TENANT')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('VERSION') || error.code.includes('INCOMPLETE') ||
          error.code.includes('COMPLETE_INVALID') || error.code.includes('CANCEL_INVALID')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'RECRUITMENT_INTERVIEW_UNIQUE_CONFLICT', message: '面试轮次或面试官评价已存在',
      });
      throw error;
    }
  }
}

function interviewSummary(interview: RecruitmentInterview): RecruitmentInterviewSummary {
  return Object.freeze({
    id: interview.id, applicationId: interview.applicationId, roundNumber: interview.roundNumber,
    mode: interview.mode, startsAt: interview.startsAt, endsAt: interview.endsAt,
    timezone: interview.timezone, interviewerIds: Object.freeze([...interview.interviewerIds]),
    status: interview.status, version: interview.version,
    completedAt: interview.completedAt, cancelledAt: interview.cancelledAt,
  });
}

function feedbackReceipt(value: {
  readonly id: string; readonly interviewId: string;
  readonly interviewerId: string; readonly submittedAt: string;
}): RecruitmentFeedbackReceipt {
  return Object.freeze({
    id: value.id, interviewId: value.interviewId,
    interviewerId: value.interviewerId, submittedAt: value.submittedAt,
  });
}

function sameMigratedInterview(
  left: RecruitmentInterview,
  right: RecruitmentInterview,
): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.applicationId === right.applicationId && left.roundNumber === right.roundNumber &&
    left.mode === right.mode && left.startsAt === right.startsAt && left.endsAt === right.endsAt &&
    left.timezone === right.timezone && left.location === right.location &&
    left.interviewerIds.length === right.interviewerIds.length &&
    left.interviewerIds.every((id, index) => id === right.interviewerIds[index]) &&
    left.status === right.status && left.version === right.version &&
    left.completedAt === right.completedAt && left.cancelledAt === right.cancelledAt &&
    left.createdBy === right.createdBy && left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt;
}

function sameMigratedFeedback(
  left: readonly RecruitmentInterviewMigrationFeedback[],
  right: readonly RecruitmentInterviewMigrationFeedback[],
): boolean {
  const candidates = new Map(right.map((item) => [item.interviewerId, item] as const));
  return left.length === right.length && left.every((item) => {
    const candidate = candidates.get(item.interviewerId);
    return candidate !== undefined && item.id === candidate.id &&
      item.interviewerId === candidate.interviewerId &&
      item.recommendation === candidate.recommendation && item.score === candidate.score &&
      item.notes === candidate.notes && item.submittedAt === candidate.submittedAt;
  });
}

function assertInterviewMigrationEvidence(reference: string, checksum: string): void {
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(reference) || !HASH_PATTERN.test(checksum)) {
    throw new BadRequestException({
      code: 'RECRUITMENT_MIGRATION_INTERVIEW_EVIDENCE_INVALID',
      message: '面试迁移必须精确引用迁移账本 WORM 证据与校验和',
    });
  }
}

function requiredDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RecruitmentDomainError(
    'RECRUITMENT_INVALID_DATE', '时间格式无效',
  );
  return date;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
