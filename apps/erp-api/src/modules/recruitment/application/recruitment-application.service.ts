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
import {
  buildCandidateApplicationCreatedEvent,
  buildCandidateApplicationStageEvent,
  createCandidate,
  createCandidateApplication,
  grantCandidateConsent,
  RecruitmentDomainError,
  transitionCandidateApplication,
  type CandidateApplication,
  type CandidateApplicationStage,
} from '../domain/index.js';
import { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  CandidateConsentEvidenceRepository,
  RecruitmentCandidateRepository,
  RecruitmentPositionRepository,
  RecruitmentWriteConflictError,
} from '../persistence/recruitment.repositories.js';

export interface CandidateApplicationSummary extends Record<string, unknown> {
  readonly id: string;
  readonly candidateId: string;
  readonly positionId: string;
  readonly stage: CandidateApplicationStage;
  readonly version: number;
  readonly appliedAt: string;
  readonly endedAt: string | null;
}

/** 招聘应用服务；REST、MCP、Worker 只可通过本层操作候选人和职位申请。 */
@Injectable()
export class RecruitmentApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly candidates: RecruitmentCandidateRepository,
    private readonly consents: CandidateConsentEvidenceRepository,
    private readonly positions: RecruitmentPositionRepository,
    private readonly applications: CandidateApplicationRepository,
    private readonly stages: CandidateApplicationStageRepository,
    private readonly outbox: RecruitmentOutboxWriter,
  ) {}

  async createApplication(
    key: string,
    input: {
      readonly positionId: string;
      readonly sourceChannel: string;
      readonly candidate: { readonly name: string; readonly phone?: string; readonly email?: string };
      readonly consent: {
        readonly version: string;
        readonly purpose: string;
        readonly source: 'portal' | 'channel' | 'manual_import';
        readonly expiresAt: string;
        readonly retentionExpiresAt: string;
      };
    },
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    return this.run(async () => this.idempotency.execute(
      'recruitment.application.create', key, input, async (session) => {
        const trusted = this.context.getRequired();
        const position = await this.positions.findById(input.positionId, session);
        if (position === null) throw new NotFoundException({
          code: 'RECRUITMENT_POSITION_NOT_FOUND', message: '招聘职位不存在',
        });
        if (position.status !== 'open') throw new ConflictException({
          code: 'RECRUITMENT_POSITION_NOT_OPEN', message: '职位当前不接受新申请',
        });
        const now = new Date();
        const evidenceId = createEventId(now);
        const draftCandidate = createCandidate({
          id: createEventId(now), tenantId: trusted.tenant.tenantId,
          ...input.candidate,
          consentEvidenceId: evidenceId,
          consentVersion: input.consent.version,
          consentPurpose: input.consent.purpose,
          consentSource: input.consent.source,
          consentExpiresAt: requiredDate(input.consent.expiresAt),
          retentionExpiresAt: requiredDate(input.consent.retentionExpiresAt),
        }, now);
        const matches = await this.candidates.findByContacts(
          draftCandidate.phone, draftCandidate.email, session,
        );
        if (matches.length > 1) throw new ConflictException({
          code: 'CANDIDATE_IDENTITY_CONFLICT',
          message: '手机号和邮箱命中不同候选人，必须人工仲裁',
        });
        if (matches[0] !== undefined && !contactsCompatible(matches[0], draftCandidate)) {
          throw new ConflictException({
            code: 'CANDIDATE_CONTACT_CHANGE_REVIEW_REQUIRED',
            message: '联系信息与已有候选人不一致，必须完成人工身份核验',
          });
        }
        const candidate = matches[0] === undefined
          ? draftCandidate
          : grantCandidateConsent(matches[0], {
              tenantId: trusted.tenant.tenantId,
              expectedVersion: matches[0].version,
              evidenceId,
              consentVersion: input.consent.version,
              purpose: input.consent.purpose,
              source: input.consent.source,
              expiresAt: requiredDate(input.consent.expiresAt),
              retentionExpiresAt: requiredDate(input.consent.retentionExpiresAt),
            }, now);
        if (matches[0] === undefined) await this.candidates.insert(candidate, session);
        else await this.candidates.replace(candidate, candidate.version - 1, session);
        await this.consents.appendGranted(candidate, trusted.actor.actorId, session);
        const application = createCandidateApplication({
          id: createEventId(new Date(now.getTime() + 1)),
          tenantId: trusted.tenant.tenantId,
          candidateId: candidate.id,
          positionId: position.id,
          consentEvidenceId: evidenceId,
          sourceChannel: input.sourceChannel,
        }, now);
        await this.applications.insert(application, session);
        await this.outbox.append(buildCandidateApplicationCreatedEvent(application), session);
        return { application: summary(application) };
      },
    ));
  }

  async transitionApplication(
    id: string,
    expectedVersion: number,
    key: string,
    input: {
      readonly targetStage: Exclude<CandidateApplicationStage, 'applied'>;
      readonly reasonCode?: string;
      readonly evidenceId?: string;
    },
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    if (!['screening', 'interview', 'rejected', 'withdrawn'].includes(input.targetStage)) {
      throw new ForbiddenException({
        code: 'RECRUITMENT_DEDICATED_WORKFLOW_REQUIRED',
        message: 'Offer、签署、入职和雇佣阶段只能由验证真实证据的专用工作流推进',
      });
    }
    return this.run(async () => this.idempotency.execute(
      'recruitment.application.transition', key, { id, expectedVersion, ...input },
      async (session) => {
        const current = await this.requireApplication(id, session);
        const result = transitionCandidateApplication(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          actorId: this.context.getActorRequired().actorId,
          ...input,
        }, new Date());
        await this.applications.replace(result.application, expectedVersion, session);
        await this.stages.append(result.event, session);
        await this.outbox.append(buildCandidateApplicationStageEvent(result.event), session);
        return { application: summary(result.application) };
      },
    ));
  }

  async getApplication(id: string): Promise<CandidateApplicationSummary> {
    const application = await this.requireApplication(id);
    const position = await this.positions.findById(application.positionId);
    if (position === null) throw new Error('RECRUITMENT_POSITION_REFERENCE_INVALID');
    const actor = this.context.getActorRequired();
    if (
      !actor.scopes.includes('erp:recruitment:application:read_all') &&
      !actor.departmentIds.includes(position.departmentId)
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_APPLICATION_READ_DENIED', message: '无权读取该职位申请',
    });
    return summary(application);
  }

  private async requireApplication(
    id: string,
    session?: ClientSession,
  ): Promise<CandidateApplication> {
    const application = await this.applications.findById(id, session);
    if (application === null) throw new NotFoundException({
      code: 'RECRUITMENT_APPLICATION_NOT_FOUND', message: '候选申请不存在',
    });
    return application;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RecruitmentWriteConflictError) {
        throw new ConflictException({ code: 'RECRUITMENT_VERSION_CONFLICT', message: error.message });
      }
      if (error instanceof RecruitmentDomainError) {
        if (error.code.includes('TENANT') || error.code.includes('DENIED')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (error.code.includes('VERSION') || error.code.includes('ALREADY')) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'RECRUITMENT_UNIQUE_CONFLICT', message: '候选人或活动申请已存在',
      });
      throw error;
    }
  }
}

function summary(application: CandidateApplication): CandidateApplicationSummary {
  return Object.freeze({
    id: application.id, candidateId: application.candidateId,
    positionId: application.positionId, stage: application.stage,
    version: application.version, appliedAt: application.appliedAt, endedAt: application.endedAt,
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

function contactsCompatible(
  existing: { readonly phone: string | null; readonly email: string | null },
  incoming: { readonly phone: string | null; readonly email: string | null },
): boolean {
  return (incoming.phone === null || incoming.phone === existing.phone) &&
    (incoming.email === null || incoming.email === existing.email);
}
