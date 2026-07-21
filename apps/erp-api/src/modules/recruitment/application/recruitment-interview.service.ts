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
  cancelRecruitmentInterview,
  completeRecruitmentInterview,
  createRecruitmentInterview,
  RecruitmentDomainError,
  submitRecruitmentInterviewFeedback,
  type InterviewRecommendation,
  type RecruitmentInterview,
  type RecruitmentInterviewMode,
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
    if (!actor.scopes.includes('erp:integration:calendar:deliver')) {
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
