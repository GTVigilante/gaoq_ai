import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  buildCandidateApplicationCreatedEvent,
  buildCandidateApplicationStageEvent,
  buildCandidateMigratedEvent,
  createCandidate,
  createCandidateApplication,
  grantCandidateConsent,
  RecruitmentDomainError,
  restoreCandidateFromMigration,
  transitionCandidateApplication,
  type Candidate,
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

export interface RecruitmentChannelApplicationProjection {
  readonly id: string;
  readonly sourceChannel: string;
  readonly version: number;
}

export interface CreateCandidateApplicationInput {
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
}

export interface ImportRecruitmentCandidateFromMigrationInput {
  readonly targetId: string | null;
  readonly status: Candidate['status'];
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly consentVersion: string;
  readonly consentPurpose: string;
  readonly consentCapturedAt: string;
  readonly consentExpiresAt: string;
  readonly consentWithdrawnAt: string | null;
  readonly retentionExpiresAt: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface RecruitmentCandidateMigrationSummary extends Record<string, unknown> {
  readonly id: string;
  readonly status: Candidate['status'];
  readonly consentEvidenceId: string;
  readonly consentVersion: string;
  readonly version: number;
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

  /** 数据迁移专用：明文只进入现有加密仓储，响应、事件和幂等快照均不含直接身份。 */
  async importCandidateFromMigration(
    key: string,
    input: ImportRecruitmentCandidateFromMigrationInput,
  ): Promise<{ readonly candidate: RecruitmentCandidateMigrationSummary }> {
    this.assertMigrationWriter();
    assertCandidateMigrationEvidence(input.migrationEvidenceRef, input.evidenceChecksum);
    return this.run(async () => this.idempotency.execute(
      'recruitment.candidate.import_from_migration', key, input, async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const existing = input.targetId === null
          ? null
          : await this.candidates.findById(input.targetId, session);
        const candidate = restoreCandidateFromMigration({
          ...input,
          id: input.targetId ?? createEventId(),
          tenantId,
          consentEvidenceId: existing?.consent.evidenceId ??
            createEventId(),
        }, new Date());
        if (input.targetId !== null) {
          const evidence = existing === null
            ? null
            : await this.consents.findMigrationEvidenceById(existing.consent.evidenceId, session);
          if (existing === null || evidence === null ||
            !sameMigratedCandidate(existing, candidate) ||
            evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
            evidence.evidenceChecksum !== input.evidenceChecksum) throw new ConflictException({
            code: 'RECRUITMENT_MIGRATION_CANDIDATE_IMMUTABLE',
            message: '既有候选人与迁移隐私快照或 WORM 证据不一致，禁止覆盖',
          });
          return { candidate: migrationCandidateSummary(existing) };
        }
        await this.candidates.insert(candidate, session);
        await this.consents.appendMigrated(
          candidate,
          this.context.getActorRequired().actorId,
          input.migrationEvidenceRef,
          input.evidenceChecksum,
          session,
        );
        await this.outbox.append(buildCandidateMigratedEvent(candidate), session);
        return { candidate: migrationCandidateSummary(candidate) };
      },
    ));
  }

  async createApplication(
    key: string,
    input: CreateCandidateApplicationInput,
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    if (input.consent.source === 'channel') throw new ForbiddenException({
      code: 'RECRUITMENT_CHANNEL_WORKER_REQUIRED',
      message: '渠道投递必须由验证后的 Integration Worker 入箱',
    });
    if (input.consent.source === 'manual_import') throw new ForbiddenException({
      code: 'RECRUITMENT_MANUAL_IMPORT_WORKFLOW_REQUIRED',
      message: '人工导入必须通过带证据校验与人工复核的专用工作流',
    });
    if (input.sourceChannel !== 'portal') throw new BadRequestException({
      code: 'RECRUITMENT_SOURCE_CHANNEL_INVALID',
      message: '门户申请的来源渠道必须为 portal',
    });
    return this.createApplicationCore(key, input);
  }

  /** 招聘渠道 Worker 窄接口；不接受 REST/MCP 伪造的渠道事实。 */
  async createApplicationFromChannel(
    key: string,
    input: CreateCandidateApplicationInput,
    evidence: { readonly consentEvidenceId: string },
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'system_job' ||
      !actor.scopes.includes('erp:recruitment:channel:ingest') ||
      input.consent.source !== 'channel'
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_TRUSTED_CHANNEL_REQUIRED',
      message: '只允许受信任招聘渠道 Worker 建立渠道申请',
    });
    if (!ULID_PATTERN.test(evidence.consentEvidenceId)) throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_CONSENT_EVIDENCE_INVALID',
      message: '渠道同意证据标识无效',
    });
    return this.createApplicationCore(key, input, evidence.consentEvidenceId);
  }

  private async createApplicationCore(
    key: string,
    input: CreateCandidateApplicationInput,
    trustedConsentEvidenceId?: string,
  ): Promise<{ readonly application: CandidateApplicationSummary }> {
    const request = trustedConsentEvidenceId === undefined
      ? input
      : { ...input, trustedConsentEvidenceId };
    return this.run(async () => this.idempotency.execute(
      'recruitment.application.create', key, request, async (session) => {
        const trusted = this.context.getRequired();
        const position = await this.positions.findById(input.positionId, session);
        if (position === null) throw new NotFoundException({
          code: 'RECRUITMENT_POSITION_NOT_FOUND', message: '招聘职位不存在',
        });
        if (position.status !== 'open') throw new ConflictException({
          code: 'RECRUITMENT_POSITION_NOT_OPEN', message: '职位当前不接受新申请',
        });
        const now = new Date();
        const evidenceId = trustedConsentEvidenceId ?? createEventId(now);
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

  /** 渠道回执 Worker 窄读取接口；不向 Adapter 暴露候选人身份或内部证据。 */
  async getApplicationForChannelDelivery(
    id: string,
  ): Promise<RecruitmentChannelApplicationProjection> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'system_job' ||
      !actor.scopes.includes('erp:recruitment:channel:ack')
    ) throw new ForbiddenException({
      code: 'RECRUITMENT_CHANNEL_ACK_WORKER_REQUIRED',
      message: '只允许受信任招聘渠道回执 Worker 读取投递投影',
    });
    const application = await this.requireApplication(id);
    return Object.freeze({
      id: application.id,
      sourceChannel: application.sourceChannel,
      version: application.version,
    });
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:recruitment:migration:write')) {
      throw new ForbiddenException({
        code: 'RECRUITMENT_MIGRATION_WRITER_DENIED',
        message: '候选人迁移必须由受信任服务身份执行',
      });
    }
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

function migrationCandidateSummary(candidate: Candidate): RecruitmentCandidateMigrationSummary {
  return Object.freeze({
    id: candidate.id,
    status: candidate.status,
    consentEvidenceId: candidate.consent.evidenceId,
    consentVersion: candidate.consent.version,
    version: candidate.version,
  });
}

function sameMigratedCandidate(left: Candidate, right: Candidate): boolean {
  return left.id === right.id && left.tenantId === right.tenantId &&
    left.status === right.status && left.name === right.name && left.phone === right.phone &&
    left.email === right.email && left.consent.evidenceId === right.consent.evidenceId &&
    left.consent.version === right.consent.version &&
    left.consent.purpose === right.consent.purpose &&
    left.consent.source === right.consent.source &&
    left.consent.capturedAt === right.consent.capturedAt &&
    left.consent.expiresAt === right.consent.expiresAt &&
    left.consent.withdrawnAt === right.consent.withdrawnAt &&
    left.retentionExpiresAt === right.retentionExpiresAt && left.version === right.version &&
    left.createdAt === right.createdAt && left.updatedAt === right.updatedAt;
}

function assertCandidateMigrationEvidence(reference: string, checksum: string): void {
  if (!MIGRATION_EVIDENCE_REF_PATTERN.test(reference) || !HASH_PATTERN.test(checksum)) {
    throw new BadRequestException({
      code: 'RECRUITMENT_MIGRATION_CANDIDATE_EVIDENCE_INVALID',
      message: '候选人迁移必须精确引用迁移账本 WORM 证据与校验和',
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

function contactsCompatible(
  existing: { readonly phone: string | null; readonly email: string | null },
  incoming: { readonly phone: string | null; readonly email: string | null },
): boolean {
  return (incoming.phone === null || incoming.phone === existing.phone) &&
    (incoming.email === null || incoming.email === existing.email);
}

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
