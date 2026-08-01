import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import {
  RecruitmentChannelRegistry,
  RecruitmentChannelTransportError,
  type RecruitmentChannelStage,
} from './recruitment-channel.adapter.js';
import { RecruitmentChannelSecretResolver } from './recruitment-channel-pull.service.js';
import {
  RecruitmentChannelBindingRecord,
  type RecruitmentChannelBindingDocument,
  RecruitmentChannelStageDeliveryRecord,
  type RecruitmentChannelStageDeliveryDocument,
  RecruitmentExternalMappingRecord,
  type RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 12;
const LOCAL_SOURCES = new Set(['portal', 'manual_import']);
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const SECRET_REF_PATTERN = /^GAOQ_RECRUITMENT_CHANNEL_[A-Z0-9_]{1,96}$/;
const STAGES: readonly RecruitmentChannelStage[] = [
  'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn',
];

/** 外部阶段回传可能已经提交；只能进入人工核验，禁止通用重试。 */
class RecruitmentChannelStageOutcomeUnknownError extends Error {}

/** 按申请版本顺序回传渠道阶段；只经招聘应用服务读取来源投影。 */
@Injectable()
export class RecruitmentChannelStageDeliveryService {
  private readonly workerId = `recruitment-channel-stage-${randomUUID()}`;
  private readonly logger = new Logger(RecruitmentChannelStageDeliveryService.name);

  constructor(
    @InjectModel(RecruitmentChannelStageDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentChannelStageDeliveryDocument>,
    @InjectModel(RecruitmentChannelBindingRecord.name)
    private readonly bindings: Model<RecruitmentChannelBindingDocument>,
    @InjectModel(RecruitmentExternalMappingRecord.name)
    private readonly mappings: Model<RecruitmentExternalMappingDocument>,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
    private readonly recruitment: RecruitmentApplicationService,
    private readonly crypto: RecruitmentDataCryptoService,
    private readonly registry: RecruitmentChannelRegistry,
    private readonly secrets: RecruitmentChannelSecretResolver,
  ) {}

  async processBatch(limit = 25): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID');
    }
    await this.quarantineStaleProcessing(new Date());
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claim();
      if (delivery === null) break;
      try {
        this.assertClaim(delivery);
      } catch (error) {
        await this.markManualReview(
          delivery,
          failureCode(error),
          'RECRUITMENT_CHANNEL_STAGE_RECORD_INVALID',
        );
        this.logger.error({
          code: 'RECRUITMENT_CHANNEL_STAGE_RECORD_INVALID',
          eventId: safeLogValue(delivery.eventId),
        });
        continue;
      }
      await this.context.run(trustedContext(delivery), async () => {
        try {
          await this.deliver(delivery);
          count += 1;
        } catch (error) {
          const code = failureCode(error);
          if (error instanceof RecruitmentChannelStageOutcomeUnknownError) {
            await this.markManualReview(delivery, code, code);
          } else {
            await this.fail(delivery, code);
          }
          await this.auditFailureAfterCommit(delivery, code);
        }
      });
    }
    return count;
  }

  private async claim(): Promise<RecruitmentChannelStageDeliveryRecord | null> {
    const now = new Date();
    return this.deliveries.findOneAndUpdate(
      {
        status: 'pending',
        nextAttemptAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: this.workerId }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { createdAt: 1 }, runValidators: true },
    ).lean().exec();
  }

  private async deliver(delivery: RecruitmentChannelStageDeliveryRecord): Promise<void> {
    const earlier = await this.deliveries.exists({
      tenantId: delivery.tenantId, applicationId: delivery.applicationId,
      applicationVersion: { $lt: delivery.applicationVersion },
      status: { $nin: ['succeeded', 'skipped'] }, eventId: { $ne: delivery.eventId },
    });
    if (earlier !== null) throw new Error('RECRUITMENT_CHANNEL_STAGE_ORDER_BLOCKED');
    const application = await this.recruitment.getApplicationForChannelDelivery(
      delivery.applicationId,
    );
    this.assertApplication(delivery, application);
    if (application.version < delivery.applicationVersion) {
      throw new Error('RECRUITMENT_CHANNEL_STAGE_VERSION_AHEAD');
    }
    if (LOCAL_SOURCES.has(application.sourceChannel)) {
      await this.finish(delivery, 'skipped', null);
      await this.auditSuccessAfterCommit(delivery, application.sourceChannel, 'skipped');
      return;
    }
    const binding = await this.bindings.findOne({
      tenantId: delivery.tenantId, channelCode: application.sourceChannel, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    this.assertBinding(delivery, application.sourceChannel, binding);
    const mapping = await this.mappings.findOne({
      tenantId: delivery.tenantId, channelCode: application.sourceChannel,
      entityType: 'application', erpEntityId: delivery.applicationId, status: 'active',
    }).lean().exec();
    if (mapping === null) throw new Error('RECRUITMENT_CHANNEL_APPLICATION_MAPPING_NOT_FOUND');
    this.assertMapping(delivery, application.sourceChannel, mapping);
    const externalApplicationId = this.decryptExternalId(mapping);
    const credential = this.secrets.resolve(binding.credentialSecretRef);
    const adapter = this.registry.adapter(application.sourceChannel);
    const result = await this.invokeExternal(
      () => adapter.acknowledgeStage(
        credential,
        {
          externalApplicationId, stage: delivery.stage,
          idempotencyKey: idempotencyKey([
            'stage', delivery.tenantId, application.sourceChannel,
            delivery.applicationId, String(delivery.applicationVersion), delivery.stage,
          ]),
        },
      ),
      'RECRUITMENT_CHANNEL_STAGE_OUTCOME_UNKNOWN',
    );
    try {
      this.assertReceiptResult(result);
      const fingerprint = this.crypto.channelFingerprints(
        delivery.tenantId, 'event', application.sourceChannel, result.receiptId,
      )[0];
      if (fingerprint === undefined) throw new Error('RECRUITMENT_CHANNEL_KEY_INVALID');
      await this.finish(delivery, 'succeeded', fingerprint);
    } catch (error) {
      throw new RecruitmentChannelStageOutcomeUnknownError(
        'RECRUITMENT_CHANNEL_STAGE_FINALIZE_UNAVAILABLE',
        { cause: error },
      );
    }
    await this.auditSuccessAfterCommit(delivery, application.sourceChannel, 'succeeded');
  }

  private decryptExternalId(mapping: RecruitmentExternalMappingRecord): string {
    const value = this.crypto.unprotect({
      tenantId: mapping.tenantId, resourceType: 'channel_mapping', resourceId: mapping.id,
    }, {
      keyId: mapping.externalIdKeyId, iv: mapping.externalIdIv,
      ciphertext: mapping.externalIdCiphertext, authTag: mapping.externalIdAuthTag,
    });
    if (typeof value !== 'string' || !opaqueId(value)) {
      throw new Error('RECRUITMENT_CHANNEL_MAPPING_CIPHERTEXT_INVALID');
    }
    return value;
  }

  private async invokeExternal<T>(
    operation: () => Promise<T>,
    outcomeUnknownCode: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof RecruitmentChannelTransportError &&
        error.outcome === 'not_committed'
      ) throw error;
      throw new RecruitmentChannelStageOutcomeUnknownError(
        outcomeUnknownCode,
        { cause: error },
      );
    }
  }

  private async quarantineStaleProcessing(now: Date): Promise<void> {
    await this.deliveries.updateMany(
      {
        status: 'processing',
        lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) },
      },
      { $set: {
        status: 'manual_review',
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        failureCode: 'RECRUITMENT_CHANNEL_STAGE_OUTCOME_UNKNOWN',
      } },
      { runValidators: true },
    );
  }

  private async markManualReview(
    delivery: RecruitmentChannelStageDeliveryRecord,
    code: string,
    fallbackCode: string,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId,
        eventId: delivery.eventId,
        status: 'processing',
        lockedBy: this.workerId,
      },
      { $set: {
        status: 'manual_review',
        failureCode: /^[A-Z0-9_]{3,128}$/.test(code) ? code : fallbackCode,
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('RECRUITMENT_CHANNEL_STAGE_MANUAL_REVIEW_LEASE_LOST');
    }
  }

  private assertClaim(delivery: RecruitmentChannelStageDeliveryRecord): void {
    if (
      !isPlainRecord(delivery) ||
      !ULID_PATTERN.test(delivery.eventId) ||
      !TENANT_ID_PATTERN.test(delivery.tenantId) ||
      !ULID_PATTERN.test(delivery.applicationId) ||
      !Number.isSafeInteger(delivery.applicationVersion) ||
      delivery.applicationVersion < 2 ||
      !STAGES.includes(delivery.stage) ||
      delivery.status !== 'processing' ||
      !Number.isInteger(delivery.attempts) ||
      delivery.attempts < 1 ||
      delivery.attempts > MAX_ATTEMPTS ||
      !(delivery.lockedAt instanceof Date) ||
      delivery.lockedBy !== this.workerId
    ) throw new Error('RECRUITMENT_CHANNEL_STAGE_RECORD_INVALID');
  }

  private assertApplication(
    delivery: RecruitmentChannelStageDeliveryRecord,
    application: {
      readonly id: string;
      readonly sourceChannel: string;
      readonly version: number;
    },
  ): void {
    if (
      !hasExactDataProperties(application, ['id', 'sourceChannel', 'version']) ||
      application.id !== delivery.applicationId ||
      !CHANNEL_PATTERN.test(application.sourceChannel) ||
      !Number.isSafeInteger(application.version) ||
      application.version < 1
    ) throw new Error('RECRUITMENT_CHANNEL_APPLICATION_PROJECTION_INVALID');
  }

  private assertBinding(
    delivery: RecruitmentChannelStageDeliveryRecord,
    channelCode: string,
    binding: RecruitmentChannelBindingRecord,
  ): void {
    if (
      !isPlainRecord(binding) ||
      !ULID_PATTERN.test(binding.id) ||
      binding.tenantId !== delivery.tenantId ||
      binding.channelCode !== channelCode ||
      binding.status !== 'active' ||
      !SECRET_REF_PATTERN.test(binding.credentialSecretRef) ||
      !this.registry.supports(binding.channelCode)
    ) throw new Error('RECRUITMENT_CHANNEL_BINDING_INVALID');
  }

  private assertMapping(
    delivery: RecruitmentChannelStageDeliveryRecord,
    channelCode: string,
    mapping: RecruitmentExternalMappingRecord,
  ): void {
    if (
      !isPlainRecord(mapping) ||
      !ULID_PATTERN.test(mapping.id) ||
      mapping.tenantId !== delivery.tenantId ||
      mapping.channelCode !== channelCode ||
      mapping.entityType !== 'application' ||
      mapping.erpEntityId !== delivery.applicationId ||
      mapping.status !== 'active' ||
      !Array.isArray(mapping.externalIdBlindIndexes) ||
      mapping.externalIdBlindIndexes.length < 1 ||
      mapping.externalIdBlindIndexes.some(
        (value) => typeof value !== 'string' || value.length > 128,
      ) ||
      [mapping.externalIdKeyId, mapping.externalIdIv, mapping.externalIdCiphertext,
        mapping.externalIdAuthTag].some(
        (value) => typeof value !== 'string' || value.length < 1,
      )
    ) throw new Error('RECRUITMENT_CHANNEL_APPLICATION_MAPPING_INVALID');
  }

  private assertReceiptResult(value: unknown): asserts value is { readonly receiptId: string } {
    if (
      !hasExactDataProperties(value, ['receiptId']) ||
      !canonicalOpaqueId(value.receiptId)
    ) throw new Error('RECRUITMENT_CHANNEL_ACKNOWLEDGEMENT_INVALID');
  }

  private async finish(
    delivery: RecruitmentChannelStageDeliveryRecord,
    status: 'succeeded' | 'skipped',
    receiptFingerprint: string | null,
  ): Promise<void> {
    const updated = await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId, eventId: delivery.eventId,
        status: 'processing', lockedBy: this.workerId,
      },
      { $set: {
        status, receiptFingerprint, succeededAt: new Date(),
        lockedAt: null, lockedBy: null, failureCode: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_STAGE_LEASE_LOST');
  }

  private async fail(delivery: RecruitmentChannelStageDeliveryRecord, code: string): Promise<void> {
    const exhausted = delivery.attempts >= MAX_ATTEMPTS;
    const now = new Date();
    const updated = await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId, eventId: delivery.eventId,
        status: 'processing', lockedBy: this.workerId,
      },
      { $set: {
        status: exhausted ? 'dead' : 'pending', failureCode: code,
        nextAttemptAt: exhausted ? now : calculateNextAttemptAt(delivery.attempts, now),
        lockedAt: null, lockedBy: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error('RECRUITMENT_CHANNEL_STAGE_FAILURE_LEASE_LOST');
    }
  }

  private async auditSuccessAfterCommit(
    delivery: RecruitmentChannelStageDeliveryRecord,
    channelCode: string,
    result: 'succeeded' | 'skipped',
  ): Promise<void> {
    try {
      await this.audit.record({
        action: 'integration.recruitment_channel.stage.deliver',
        resourceType: 'recruitment_application', resourceId: delivery.applicationId,
        riskLevel: 'R2', outcome: 'success', metadata: {
          channelCode, stage: delivery.stage,
          applicationVersion: delivery.applicationVersion, result,
        },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_CHANNEL_STAGE_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: delivery.tenantId,
        eventId: delivery.eventId,
        applicationId: delivery.applicationId,
        result,
      });
    }
  }

  private async auditFailureAfterCommit(
    delivery: RecruitmentChannelStageDeliveryRecord,
    code: string,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: 'integration.recruitment_channel.stage.deliver',
        resourceType: 'recruitment_application', resourceId: delivery.applicationId,
        riskLevel: 'R2', outcome: 'failure', metadata: {
          stage: delivery.stage, applicationVersion: delivery.applicationVersion,
          failureCode: code,
        },
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_CHANNEL_STAGE_FAILURE_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: delivery.tenantId,
        eventId: delivery.eventId,
        applicationId: delivery.applicationId,
        failureCode: code,
      });
    }
  }
}

function trustedContext(delivery: RecruitmentChannelStageDeliveryRecord) {
  return {
    tenant: { tenantId: delivery.tenantId, source: 'service_identity' as const },
    actor: {
      actorId: 'system:recruitment-channel-stage', actorType: 'system_job' as const,
      tenantId: delivery.tenantId, roleCodes: ['RECRUITMENT_CHANNEL_WORKER'],
      scopes: ['erp:recruitment:channel:ack'], departmentIds: [], traceId: delivery.eventId,
    },
  };
}

function idempotencyKey(parts: readonly string[]): string {
  return `channel-${createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url')}`;
}

function opaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function canonicalOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.normalize('NFKC') === value && opaqueId(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataProperties<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  ) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

function safeLogValue(value: unknown): string {
  return typeof value === 'string' && value.length <= 128 ? value : 'invalid';
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
  return 'RECRUITMENT_CHANNEL_STAGE_DELIVERY_FAILED';
}
