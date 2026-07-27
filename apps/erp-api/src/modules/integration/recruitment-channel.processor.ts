import { createHash } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import { RecruitmentResumeService } from '../recruitment/application/recruitment-resume.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelRegistry,
  type NormalizedRecruitmentChannelApplication,
} from './recruitment-channel.adapter.js';
import { RecruitmentChannelPullService, RecruitmentChannelSecretResolver } from './recruitment-channel-pull.service.js';
import { RecruitmentChannelPositionRelayService } from './recruitment-channel-position-relay.service.js';
import { RecruitmentChannelPositionDeliveryService } from './recruitment-channel-position-delivery.service.js';
import { RecruitmentChannelStageRelayService } from './recruitment-channel-stage-relay.service.js';
import { RecruitmentChannelStageDeliveryService } from './recruitment-channel-stage-delivery.service.js';
import {
  RecruitmentChannelBindingRecord,
  type RecruitmentChannelBindingDocument,
  RecruitmentChannelInboxRecord,
  type RecruitmentChannelInboxDocument,
  RecruitmentExternalMappingRecord,
  type RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';
import {
  RECRUITMENT_CHANNEL_PROCESS_JOB,
  RECRUITMENT_CHANNEL_PULL_JOB,
  RECRUITMENT_CHANNEL_QUEUE,
  RECRUITMENT_CHANNEL_SCAN_JOB,
  RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_RELAY_STAGES_JOB,
  RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB,
  type RecruitmentChannelJobData,
} from './recruitment-channel.queue.js';

const tenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const pullJobSchema = z.object({
  tenantId: tenantIdSchema, bindingId: z.string().regex(ULID_PATTERN),
}).strict();
const processJobSchema = z.object({
  tenantId: tenantIdSchema, inboxId: z.string().regex(ULID_PATTERN),
}).strict();
const normalizedSchema = z.object({
  externalPositionId: z.string().min(1).max(256),
  externalCandidateId: z.string().min(1).max(256),
  externalApplicationId: z.string().min(1).max(256),
  candidate: z.object({
    name: z.string().min(1).max(128),
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional(),
    email: z.string().email().max(254).optional(),
  }).strict().refine((value) => value.phone !== undefined || value.email !== undefined),
  consent: z.object({
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    purpose: z.string().min(3).max(256),
    expiresAt: z.string().datetime({ offset: true }),
    retentionExpiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  attachmentReferences: z.array(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  ).max(20),
}).strict();

const PROCESSING_LEASE_MS = 15 * 60 * 1_000;

/** 招聘渠道 Worker：补拉、解密、标准化、证据校验、领域写入和阶段回执串成可恢复链路。 */
@Processor(RECRUITMENT_CHANNEL_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class RecruitmentChannelProcessor extends WorkerHost {
  private readonly logger = new Logger(RecruitmentChannelProcessor.name);

  constructor(
    @InjectModel(RecruitmentChannelBindingRecord.name)
    private readonly bindings: Model<RecruitmentChannelBindingDocument>,
    @InjectModel(RecruitmentChannelInboxRecord.name)
    private readonly inbox: Model<RecruitmentChannelInboxDocument>,
    @InjectModel(RecruitmentExternalMappingRecord.name)
    private readonly mappings: Model<RecruitmentExternalMappingDocument>,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
    private readonly pull: RecruitmentChannelPullService,
    private readonly recruitment: RecruitmentApplicationService,
    private readonly resumes: RecruitmentResumeService,
    private readonly crypto: RecruitmentDataCryptoService,
    private readonly registry: RecruitmentChannelRegistry,
    private readonly secrets: RecruitmentChannelSecretResolver,
    private readonly positionRelay: RecruitmentChannelPositionRelayService,
    private readonly positionDeliveries: RecruitmentChannelPositionDeliveryService,
    private readonly stageRelay: RecruitmentChannelStageRelayService,
    private readonly stageDeliveries: RecruitmentChannelStageDeliveryService,
  ) { super(); }

  override async process(job: Job<RecruitmentChannelJobData>): Promise<number> {
    if (job.name === RECRUITMENT_CHANNEL_SCAN_JOB) {
      z.object({}).strict().parse(job.data);
      return this.pull.enqueueDueBindings();
    }
    if (job.name === RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB) {
      z.object({}).strict().parse(job.data);
      return this.positionRelay.relayBatch('recruitment-channel-relay', 50);
    }
    if (job.name === RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB) {
      z.object({}).strict().parse(job.data);
      return this.positionDeliveries.processBatch(25);
    }
    if (job.name === RECRUITMENT_CHANNEL_RELAY_STAGES_JOB) {
      z.object({}).strict().parse(job.data);
      return this.stageRelay.relayBatch('recruitment-channel-stage-relay', 50);
    }
    if (job.name === RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB) {
      z.object({}).strict().parse(job.data);
      return this.stageDeliveries.processBatch(25);
    }
    if (job.name === RECRUITMENT_CHANNEL_PULL_JOB) {
      const data = pullJobSchema.parse(job.data);
      return this.runTrusted(data.tenantId, data.bindingId, 'pull', async () => {
        try {
          const count = await this.pull.pullBinding(data.bindingId);
          await this.auditAfterCommit({
            action: 'integration.recruitment_channel.pull',
            resourceType: 'recruitment_channel_binding', resourceId: data.bindingId,
            riskLevel: 'R1', outcome: 'success', metadata: { deliveryCount: count },
          }, {
            code: 'RECRUITMENT_CHANNEL_PULL_AUDIT_AFTER_COMMIT_FAILED',
            tenantId: data.tenantId, bindingId: data.bindingId,
          });
          return count;
        } catch (error) {
          await this.auditAfterCommit({
            action: 'integration.recruitment_channel.pull',
            resourceType: 'recruitment_channel_binding', resourceId: data.bindingId,
            riskLevel: 'R1', outcome: 'failure', metadata: { failureCode: failureCode(error) },
          }, {
            code: 'RECRUITMENT_CHANNEL_PULL_FAILURE_AUDIT_AFTER_COMMIT_FAILED',
            tenantId: data.tenantId, bindingId: data.bindingId,
          });
          throw error;
        }
      });
    }
    if (job.name !== RECRUITMENT_CHANNEL_PROCESS_JOB) {
      throw new Error('RECRUITMENT_CHANNEL_JOB_UNKNOWN');
    }
    const data = processJobSchema.parse(job.data);
    return this.runTrusted(data.tenantId, data.inboxId, 'process', () =>
      this.processInbox(data.tenantId, data.inboxId));
  }

  private async processInbox(tenantId: string, inboxId: string): Promise<number> {
    const staleAt = new Date(Date.now() - PROCESSING_LEASE_MS);
    const claimed = await this.inbox.findOneAndUpdate(
      {
        tenantId, id: inboxId,
        $or: [
          { status: { $in: ['pending', 'failed'] } },
          { status: 'processing', processingStartedAt: { $lte: staleAt } },
        ],
      },
      {
        $set: { status: 'processing', processingStartedAt: new Date(), failureCode: null },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return 0;
    try {
      const raw = this.crypto.unprotect({
        tenantId, resourceType: 'channel_inbox', resourceId: claimed.id,
      }, {
        keyId: claimed.payloadKeyId, iv: claimed.payloadIv,
        ciphertext: claimed.payloadCiphertext, authTag: claimed.payloadAuthTag,
      });
      const normalizer = this.registry.normalizer(claimed.channelCode);
      let normalized: NormalizedRecruitmentChannelApplication;
      try {
        normalized = exactNormalized(
          normalizedSchema.parse(await normalizer.normalize(raw)),
        );
      } catch (error) {
        await this.finishReview(claimed, normalizationFailureCode(error), normalizer.schemaVersion);
        return 1;
      }
      let evidence: {
        readonly consentEvidenceId: string;
        readonly resumeSnapshotId: string | null;
      };
      if (claimed.evidenceVerifiedAt !== null && claimed.evidenceVerifiedAt !== undefined) {
        if (claimed.normalizerVersion !== normalizer.schemaVersion) {
          await this.finishReview(
            claimed, 'RECRUITMENT_CHANNEL_NORMALIZER_VERSION_CHANGED',
            claimed.normalizerVersion ?? normalizer.schemaVersion,
          );
          return 1;
        }
        if (
          claimed.consentEvidenceId === null || !ULID_PATTERN.test(claimed.consentEvidenceId) ||
          (claimed.resumeSnapshotId !== null && !opaqueId(claimed.resumeSnapshotId))
        ) throw new Error('RECRUITMENT_CHANNEL_EVIDENCE_CHECKPOINT_INVALID');
        evidence = {
          consentEvidenceId: claimed.consentEvidenceId,
          resumeSnapshotId: claimed.resumeSnapshotId,
        };
      } else {
        const verified = await this.registry.verifier(claimed.channelCode).verify({
          tenantId, inboxId: claimed.id, application: normalized,
        });
        if (
          !verified.verified || !ULID_PATTERN.test(verified.consentEvidenceId) ||
          (verified.resumeSnapshotId !== null && !opaqueId(verified.resumeSnapshotId))
        ) throw new Error('RECRUITMENT_CHANNEL_EVIDENCE_UNVERIFIED');
        const checkpoint = await this.inbox.updateOne(
          { tenantId, id: claimed.id, status: 'processing' },
          { $set: {
            normalizerVersion: normalizer.schemaVersion, evidenceVerifiedAt: new Date(),
            consentEvidenceId: verified.consentEvidenceId,
            resumeSnapshotId: verified.resumeSnapshotId,
          } },
          { runValidators: true },
        );
        if (checkpoint.modifiedCount !== 1) {
          throw new Error('RECRUITMENT_CHANNEL_INBOX_LEASE_LOST');
        }
        evidence = {
          consentEvidenceId: verified.consentEvidenceId,
          resumeSnapshotId: verified.resumeSnapshotId,
        };
      }
      const positionId = await this.resolvePosition(
        tenantId, claimed.channelCode, normalized.externalPositionId,
      );
      const result = await this.recruitment.createApplicationFromChannel(
        idempotencyKey(['application', tenantId, claimed.id]),
        {
          positionId, sourceChannel: claimed.channelCode, candidate: normalized.candidate,
          consent: { ...normalized.consent, source: 'channel' },
        },
        { consentEvidenceId: evidence.consentEvidenceId },
      );
      if (evidence.resumeSnapshotId !== null) {
        await this.resumes.requestAnalysisFromTrustedEvidence(
          idempotencyKey(['resume-analysis', tenantId, claimed.id]),
          result.application.candidateId,
          evidence.resumeSnapshotId,
        );
      }
      await this.ensureMapping(
        tenantId, claimed.channelCode, 'candidate', result.application.candidateId,
        normalized.externalCandidateId,
      );
      await this.ensureMapping(
        tenantId, claimed.channelCode, 'application', result.application.id,
        normalized.externalApplicationId,
      );
      const binding = await this.bindings.findOne({
        tenantId, id: claimed.bindingId, status: 'active', channelCode: claimed.channelCode,
      }).lean().exec();
      if (binding === null) throw new Error('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
      const acknowledgement = await this.registry.adapter(claimed.channelCode).acknowledgeStage(
        this.secrets.resolve(binding.credentialSecretRef),
        {
          externalApplicationId: normalized.externalApplicationId, stage: 'applied',
          idempotencyKey: idempotencyKey(['ack', tenantId, claimed.id]),
        },
      );
      if (!opaqueId(acknowledgement.receiptId)) {
        throw new Error('RECRUITMENT_CHANNEL_ACKNOWLEDGEMENT_INVALID');
      }
      const acknowledgementFingerprint = this.crypto.channelFingerprints(
        tenantId, 'event', claimed.channelCode, acknowledgement.receiptId,
      )[0];
      if (acknowledgementFingerprint === undefined) throw new Error('RECRUITMENT_CHANNEL_KEY_INVALID');
      const updated = await this.inbox.updateOne(
        { tenantId, id: claimed.id, status: 'processing' },
        { $set: {
          status: 'completed', processingStartedAt: null, processedAt: new Date(),
          failureCode: null, normalizerVersion: normalizer.schemaVersion,
          applicationId: result.application.id, consentEvidenceId: evidence.consentEvidenceId,
          resumeSnapshotId: evidence.resumeSnapshotId, acknowledgementFingerprint,
        } },
        { runValidators: true },
      );
      if (updated.modifiedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_INBOX_LEASE_LOST');
      await this.auditAfterCommit({
        action: 'integration.recruitment_channel.application.apply',
        resourceType: 'recruitment_application', resourceId: result.application.id,
        riskLevel: 'R2', outcome: 'success', metadata: {
          channelCode: claimed.channelCode, normalizerVersion: normalizer.schemaVersion,
          resumeArchived: evidence.resumeSnapshotId !== null,
        },
      }, {
        code: 'RECRUITMENT_CHANNEL_APPLICATION_AUDIT_AFTER_COMMIT_FAILED',
        tenantId, inboxId: claimed.id, applicationId: result.application.id,
      });
      return 1;
    } catch (error) {
      await this.failInbox(claimed, failureCode(error));
      await this.auditAfterCommit({
        action: 'integration.recruitment_channel.application.apply',
        resourceType: 'recruitment_channel_inbox', resourceId: claimed.id,
        riskLevel: 'R2', outcome: 'failure', metadata: {
          channelCode: claimed.channelCode, failureCode: failureCode(error),
        },
      }, {
        code: 'RECRUITMENT_CHANNEL_APPLICATION_FAILURE_AUDIT_AFTER_COMMIT_FAILED',
        tenantId, inboxId: claimed.id,
      });
      throw error;
    }
  }

  private async resolvePosition(
    tenantId: string,
    channelCode: string,
    externalPositionId: string,
  ): Promise<string> {
    const fingerprints = this.crypto.channelFingerprints(
      tenantId, 'position', channelCode, externalPositionId,
    );
    const mappings = await this.mappings.find({
      tenantId, channelCode, entityType: 'position', status: 'active',
      externalIdBlindIndexes: { $in: [...fingerprints] },
    }).limit(2).lean().exec();
    if (mappings.length !== 1 || mappings[0] === undefined) {
      throw new Error(mappings.length === 0
        ? 'RECRUITMENT_CHANNEL_POSITION_UNBOUND'
        : 'RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT');
    }
    return mappings[0].erpEntityId;
  }

  private async ensureMapping(
    tenantId: string,
    channelCode: string,
    entityType: 'candidate' | 'application',
    erpEntityId: string,
    externalId: string,
  ): Promise<void> {
    const fingerprints = this.crypto.channelFingerprints(
      tenantId, entityType, channelCode, externalId,
    );
    const existing = await this.mappings.findOne({
      tenantId, channelCode, entityType, externalIdBlindIndexes: { $in: [...fingerprints] },
    }).lean().exec();
    if (existing !== null) {
      if (existing.erpEntityId !== erpEntityId) throw new Error('RECRUITMENT_CHANNEL_MAPPING_CONFLICT');
      return;
    }
    const id = createEventId();
    const protectedId = this.crypto.protect({
      tenantId, resourceType: 'channel_mapping', resourceId: id,
    }, externalId);
    try {
      await this.mappings.create({
        id, tenantId, channelCode, entityType, erpEntityId,
        externalIdBlindIndexes: [...fingerprints],
        externalIdKeyId: protectedId.keyId, externalIdIv: protectedId.iv,
        externalIdCiphertext: protectedId.ciphertext, externalIdAuthTag: protectedId.authTag,
        status: 'active',
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.mappings.findOne({
        tenantId, channelCode, entityType, externalIdBlindIndexes: { $in: [...fingerprints] },
      }).lean().exec();
      if (raced?.erpEntityId !== erpEntityId) {
        throw new Error('RECRUITMENT_CHANNEL_MAPPING_CONFLICT', { cause: error });
      }
    }
  }

  private async finishReview(
    inbox: RecruitmentChannelInboxRecord,
    code: string,
    normalizerVersion: string,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId: inbox.tenantId, id: inbox.id, status: 'processing' },
      { $set: {
        status: 'manual_review', processingStartedAt: null, processedAt: new Date(),
        failureCode: code, normalizerVersion,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_INBOX_LEASE_LOST');
    await this.auditAfterCommit({
      action: 'integration.recruitment_channel.application.review',
      resourceType: 'recruitment_channel_inbox', resourceId: inbox.id,
      riskLevel: 'R2', outcome: 'failure', metadata: {
        channelCode: inbox.channelCode, failureCode: code, normalizerVersion,
      },
    }, {
      code: 'RECRUITMENT_CHANNEL_REVIEW_AUDIT_AFTER_COMMIT_FAILED',
      tenantId: inbox.tenantId, inboxId: inbox.id,
    });
  }

  private async failInbox(inbox: RecruitmentChannelInboxRecord, code: string): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId: inbox.tenantId, id: inbox.id, status: 'processing' },
      { $set: {
        status: 'failed', processingStartedAt: null, processedAt: null, failureCode: code,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_INBOX_LEASE_LOST');
  }

  private async auditAfterCommit(
    input: AuditRecordInput,
    context: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error(context);
    }
  }

  private runTrusted<T>(
    tenantId: string,
    traceId: string,
    mode: 'pull' | 'process',
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.context.run({
      tenant: { tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:recruitment-channel', actorType: 'system_job', tenantId,
        roleCodes: ['RECRUITMENT_CHANNEL_WORKER'],
        scopes: mode === 'pull'
          ? ['erp:recruitment:channel:pull']
          : ['erp:recruitment:channel:ingest'],
        departmentIds: [], traceId,
      },
    }, operation);
  }
}

function idempotencyKey(parts: readonly string[]): string {
  return `channel-${createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url')}`;
}

function exactNormalized(
  value: z.infer<typeof normalizedSchema>,
): NormalizedRecruitmentChannelApplication {
  return Object.freeze({
    externalPositionId: value.externalPositionId,
    externalCandidateId: value.externalCandidateId,
    externalApplicationId: value.externalApplicationId,
    candidate: Object.freeze({
      name: value.candidate.name,
      ...(value.candidate.phone === undefined ? {} : { phone: value.candidate.phone }),
      ...(value.candidate.email === undefined ? {} : { email: value.candidate.email }),
    }),
    consent: Object.freeze({ ...value.consent }),
    attachmentReferences: Object.freeze([...value.attachmentReferences]),
  });
}

function opaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function normalizationFailureCode(error: unknown): string {
  if (error instanceof z.ZodError) return 'RECRUITMENT_CHANNEL_NORMALIZED_PAYLOAD_INVALID';
  return failureCode(error) === 'RECRUITMENT_CHANNEL_PROCESSING_FAILED'
    ? 'RECRUITMENT_CHANNEL_NORMALIZATION_FAILED'
    : failureCode(error);
}

function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z0-9_]{3,128}$/.test(code)) return code;
    }
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'RECRUITMENT_CHANNEL_PROCESSING_FAILED';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
