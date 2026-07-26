import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { DepartmentRepository } from '../org/persistence/org.repositories.js';
import { RecruitmentManagementService } from '../recruitment/application/recruitment-management.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import { RecruitmentChannelRegistry } from './recruitment-channel.adapter.js';
import { RecruitmentChannelSecretResolver } from './recruitment-channel-pull.service.js';
import {
  RecruitmentChannelBindingRecord,
  type RecruitmentChannelBindingDocument,
  RecruitmentChannelPositionDeliveryRecord,
  type RecruitmentChannelPositionDeliveryDocument,
  RecruitmentExternalMappingRecord,
  type RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 12;

/** 执行职位发布/下架投递，用强版本和外部映射防止乱序、重复职位。 */
@Injectable()
export class RecruitmentChannelPositionDeliveryService {
  private readonly workerId = `recruitment-channel-${randomUUID()}`;

  constructor(
    @InjectModel(RecruitmentChannelPositionDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentChannelPositionDeliveryDocument>,
    @InjectModel(RecruitmentChannelBindingRecord.name)
    private readonly bindings: Model<RecruitmentChannelBindingDocument>,
    @InjectModel(RecruitmentExternalMappingRecord.name)
    private readonly mappings: Model<RecruitmentExternalMappingDocument>,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
    private readonly management: RecruitmentManagementService,
    private readonly departments: DepartmentRepository,
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
      await this.context.run({
        tenant: { tenantId: delivery.tenantId, source: 'service_identity' },
        actor: {
          actorId: 'system:recruitment-channel', actorType: 'system_job',
          tenantId: delivery.tenantId, roleCodes: ['RECRUITMENT_CHANNEL_WORKER'],
          scopes: ['erp:recruitment:management:read_all'], departmentIds: [],
          traceId: delivery.eventId,
        },
      }, async () => {
        try {
          await this.deliver(delivery);
          count += 1;
        } catch (error) {
          await this.fail(delivery, failureCode(error));
          await this.audit.record({
            action: 'integration.recruitment_channel.position.deliver',
            resourceType: 'recruitment_position', resourceId: delivery.positionId,
            riskLevel: 'R2', outcome: 'failure', metadata: {
              channelCode: delivery.channelCode, action: delivery.action,
              failureCode: failureCode(error), positionVersion: delivery.positionVersion,
            },
          });
        }
      });
    }
    return count;
  }

  private async claim(): Promise<RecruitmentChannelPositionDeliveryRecord | null> {
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

  private async deliver(delivery: RecruitmentChannelPositionDeliveryRecord): Promise<void> {
    const earlier = await this.deliveries.exists({
      tenantId: delivery.tenantId, positionId: delivery.positionId,
      channelCode: delivery.channelCode, positionVersion: { $lt: delivery.positionVersion },
      status: { $in: ['pending', 'processing'] }, eventId: { $ne: delivery.eventId },
    });
    if (earlier !== null) throw new Error('RECRUITMENT_CHANNEL_POSITION_ORDER_BLOCKED');
    const position = await this.management.getPosition(delivery.positionId);
    if (position.version > delivery.positionVersion) {
      await this.finish(delivery, 'superseded', null);
      await this.audit.record({
        action: 'integration.recruitment_channel.position.deliver',
        resourceType: 'recruitment_position', resourceId: delivery.positionId,
        riskLevel: 'R2', outcome: 'success', metadata: {
          channelCode: delivery.channelCode, action: delivery.action,
          targetStatus: delivery.targetStatus, positionVersion: delivery.positionVersion,
          result: 'superseded',
        },
      });
      return;
    }
    if (position.version !== delivery.positionVersion || position.status !== delivery.targetStatus) {
      throw new Error('RECRUITMENT_CHANNEL_POSITION_VERSION_MISMATCH');
    }
    const binding = await this.bindings.findOne({
      tenantId: delivery.tenantId, id: delivery.bindingId,
      channelCode: delivery.channelCode, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    const credential = this.secrets.resolve(binding.credentialSecretRef);
    const adapter = this.registry.adapter(delivery.channelCode);
    let receiptId: string;
    if (delivery.action === 'publish') {
      const department = await this.departments.findById(position.departmentId);
      if (department === null || department.status !== 'active') {
        throw new Error('RECRUITMENT_CHANNEL_DEPARTMENT_INVALID');
      }
      const result = await adapter.publishPosition(credential, {
        tenantId: delivery.tenantId, positionId: position.id, title: position.title,
        departmentCode: department.code, location: position.location,
        headcount: position.headcount,
        idempotencyKey: idempotencyKey(['publish', delivery.tenantId, delivery.channelCode, position.id]),
      });
      if (!opaqueId(result.externalPositionId) || !opaqueId(result.receiptId)) {
        throw new Error('RECRUITMENT_CHANNEL_POSITION_RECEIPT_INVALID');
      }
      await this.ensurePositionMapping(delivery, result.externalPositionId, 'active');
      receiptId = result.receiptId;
    } else {
      const mapping = await this.mappingByPosition(delivery);
      if (mapping === null) {
        receiptId = `not-published:${delivery.eventId}`;
      } else {
        const externalPositionId = this.decryptExternalId(mapping);
        const result = await adapter.closePosition(credential, {
          externalPositionId,
          idempotencyKey: idempotencyKey([
            'close', delivery.tenantId, delivery.channelCode,
            delivery.positionId, delivery.targetStatus,
          ]),
        });
        if (!opaqueId(result.receiptId)) throw new Error('RECRUITMENT_CHANNEL_POSITION_RECEIPT_INVALID');
        await this.setMappingStatus(
          mapping,
          delivery.targetStatus === 'paused' ? 'paused' : 'closed',
        );
        receiptId = result.receiptId;
      }
    }
    const fingerprint = this.crypto.channelFingerprints(
      delivery.tenantId, 'event', delivery.channelCode, receiptId,
    )[0];
    if (fingerprint === undefined) throw new Error('RECRUITMENT_CHANNEL_KEY_INVALID');
    await this.finish(delivery, 'succeeded', fingerprint);
    await this.audit.record({
      action: 'integration.recruitment_channel.position.deliver',
      resourceType: 'recruitment_position', resourceId: delivery.positionId,
      riskLevel: 'R2', outcome: 'success', metadata: {
        channelCode: delivery.channelCode, action: delivery.action,
        targetStatus: delivery.targetStatus, positionVersion: delivery.positionVersion,
      },
    });
  }

  private async ensurePositionMapping(
    delivery: RecruitmentChannelPositionDeliveryRecord,
    externalId: string,
    status: 'active',
  ): Promise<void> {
    const fingerprints = this.crypto.channelFingerprints(
      delivery.tenantId, 'position', delivery.channelCode, externalId,
    );
    const current = await this.mappingByPosition(delivery);
    if (current !== null) {
      if (!current.externalIdBlindIndexes.some((value) => fingerprints.includes(value))) {
        throw new Error('RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT');
      }
      await this.setMappingStatus(current, status);
      return;
    }
    const id = createEventId();
    const protectedId = this.crypto.protect({
      tenantId: delivery.tenantId, resourceType: 'channel_mapping', resourceId: id,
    }, externalId);
    try {
      await this.mappings.create({
        id, tenantId: delivery.tenantId, channelCode: delivery.channelCode,
        entityType: 'position', erpEntityId: delivery.positionId,
        externalIdBlindIndexes: [...fingerprints],
        externalIdKeyId: protectedId.keyId, externalIdIv: protectedId.iv,
        externalIdCiphertext: protectedId.ciphertext, externalIdAuthTag: protectedId.authTag,
        status,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.mappingByPosition(delivery);
      if (
        raced === null ||
        !raced.externalIdBlindIndexes.some((value) => fingerprints.includes(value))
      ) throw new Error('RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT', { cause: error });
      await this.setMappingStatus(raced, status);
    }
  }

  private async setMappingStatus(
    mapping: RecruitmentExternalMappingRecord,
    status: RecruitmentExternalMappingRecord['status'],
  ): Promise<void> {
    const updated = await this.mappings.updateOne(
      { tenantId: mapping.tenantId, id: mapping.id }, { $set: { status } },
      { runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_POSITION_MAPPING_LOST');
  }

  private mappingByPosition(
    delivery: RecruitmentChannelPositionDeliveryRecord,
  ): Promise<RecruitmentExternalMappingRecord | null> {
    return this.mappings.findOne({
      tenantId: delivery.tenantId, channelCode: delivery.channelCode,
      entityType: 'position', erpEntityId: delivery.positionId,
    }).lean().exec();
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
    delivery: RecruitmentChannelPositionDeliveryRecord,
    status: 'succeeded' | 'superseded',
    receiptFingerprint: string | null,
  ): Promise<void> {
    const updated = await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId, eventId: delivery.eventId,
        bindingId: delivery.bindingId, status: 'processing', lockedBy: this.workerId,
      },
      { $set: {
        status, receiptFingerprint, succeededAt: new Date(),
        lockedAt: null, lockedBy: null, failureCode: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_POSITION_LEASE_LOST');
  }

  private async fail(delivery: RecruitmentChannelPositionDeliveryRecord, code: string): Promise<void> {
    const exhausted = delivery.attempts >= MAX_ATTEMPTS;
    const now = new Date();
    await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId, eventId: delivery.eventId,
        bindingId: delivery.bindingId, status: 'processing', lockedBy: this.workerId,
      },
      { $set: {
        status: exhausted ? 'dead' : 'pending', failureCode: code,
        nextAttemptAt: exhausted ? now : calculateNextAttemptAt(delivery.attempts, now),
        lockedAt: null, lockedBy: null,
      } },
      { runValidators: true },
    );
  }
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
  return 'RECRUITMENT_CHANNEL_POSITION_DELIVERY_FAILED';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === 11_000;
}
