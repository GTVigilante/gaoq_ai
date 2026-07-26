import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import { RecruitmentChannelRegistry } from './recruitment-channel.adapter.js';
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

/** 按申请版本顺序回传渠道阶段；只经招聘应用服务读取来源投影。 */
@Injectable()
export class RecruitmentChannelStageDeliveryService {
  private readonly workerId = `recruitment-channel-stage-${randomUUID()}`;

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
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claim();
      if (delivery === null) break;
      await this.context.run(trustedContext(delivery), async () => {
        try {
          await this.deliver(delivery);
          count += 1;
        } catch (error) {
          const code = failureCode(error);
          await this.fail(delivery, code);
          await this.audit.record({
            action: 'integration.recruitment_channel.stage.deliver',
            resourceType: 'recruitment_application', resourceId: delivery.applicationId,
            riskLevel: 'R2', outcome: 'failure', metadata: {
              stage: delivery.stage, applicationVersion: delivery.applicationVersion,
              failureCode: code,
            },
          });
        }
      });
    }
    return count;
  }

  private async claim(): Promise<RecruitmentChannelStageDeliveryRecord | null> {
    const now = new Date();
    return this.deliveries.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'processing', lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
        ],
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
    if (application.version < delivery.applicationVersion) {
      throw new Error('RECRUITMENT_CHANNEL_STAGE_VERSION_AHEAD');
    }
    if (LOCAL_SOURCES.has(application.sourceChannel)) {
      await this.finish(delivery, 'skipped', null);
      await this.auditSuccess(delivery, application.sourceChannel, 'skipped');
      return;
    }
    const binding = await this.bindings.findOne({
      tenantId: delivery.tenantId, channelCode: application.sourceChannel, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    const mapping = await this.mappings.findOne({
      tenantId: delivery.tenantId, channelCode: application.sourceChannel,
      entityType: 'application', erpEntityId: delivery.applicationId, status: 'active',
    }).lean().exec();
    if (mapping === null) throw new Error('RECRUITMENT_CHANNEL_APPLICATION_MAPPING_NOT_FOUND');
    const externalApplicationId = this.decryptExternalId(mapping);
    const result = await this.registry.adapter(application.sourceChannel).acknowledgeStage(
      this.secrets.resolve(binding.credentialSecretRef),
      {
        externalApplicationId, stage: delivery.stage,
        idempotencyKey: idempotencyKey([
          'stage', delivery.tenantId, application.sourceChannel,
          delivery.applicationId, String(delivery.applicationVersion), delivery.stage,
        ]),
      },
    );
    if (!opaqueId(result.receiptId)) throw new Error('RECRUITMENT_CHANNEL_ACKNOWLEDGEMENT_INVALID');
    const fingerprint = this.crypto.channelFingerprints(
      delivery.tenantId, 'event', application.sourceChannel, result.receiptId,
    )[0];
    if (fingerprint === undefined) throw new Error('RECRUITMENT_CHANNEL_KEY_INVALID');
    await this.finish(delivery, 'succeeded', fingerprint);
    await this.auditSuccess(delivery, application.sourceChannel, 'succeeded');
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
    await this.deliveries.updateOne(
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
  }

  private auditSuccess(
    delivery: RecruitmentChannelStageDeliveryRecord,
    channelCode: string,
    result: 'succeeded' | 'skipped',
  ): Promise<void> {
    return this.audit.record({
      action: 'integration.recruitment_channel.stage.deliver',
      resourceType: 'recruitment_application', resourceId: delivery.applicationId,
      riskLevel: 'R2', outcome: 'success', metadata: {
        channelCode, stage: delivery.stage,
        applicationVersion: delivery.applicationVersion, result,
      },
    });
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
