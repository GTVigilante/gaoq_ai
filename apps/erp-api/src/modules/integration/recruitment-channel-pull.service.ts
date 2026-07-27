import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import { RecruitmentChannelRegistry } from './recruitment-channel.adapter.js';
import {
  RecruitmentChannelBindingRecord,
  type RecruitmentChannelBindingDocument,
  RecruitmentChannelInboxRecord,
  type RecruitmentChannelInboxDocument,
} from './recruitment-channel.schemas.js';
import {
  RECRUITMENT_CHANNEL_PROCESS_JOB,
  RECRUITMENT_CHANNEL_PULL_JOB,
  RECRUITMENT_CHANNEL_QUEUE,
  type RecruitmentChannelJobData,
} from './recruitment-channel.queue.js';

const PULL_LIMIT = 100;
const POLL_EVERY_MS = 5 * 60 * 1_000;
const FAILURE_RETRY_MS = 60 * 1_000;
const MAX_CURSOR_LENGTH = 2_048;
const SECRET_REF_PATTERN = /^GAOQ_RECRUITMENT_CHANNEL_[A-Z0-9_]{1,96}$/;

/** 只从受控前缀的环境注入解析渠道凭据，绑定和日志不保存正文。 */
@Injectable()
export class RecruitmentChannelSecretResolver {
  resolve(reference: string): string {
    if (!SECRET_REF_PATTERN.test(reference)) throw unavailable('RECRUITMENT_CHANNEL_SECRET_REF_INVALID');
    const value = process.env[reference];
    if (value === undefined || value.length < 16 || value.length > 16_384) {
      throw unavailable('RECRUITMENT_CHANNEL_CREDENTIAL_UNAVAILABLE');
    }
    return value;
  }
}

/** 渠道补拉编排：原始投递先加密入箱，再排队标准化，不在拉取请求内写领域集合。 */
@Injectable()
export class RecruitmentChannelPullService {
  constructor(
    @InjectModel(RecruitmentChannelBindingRecord.name)
    private readonly bindings: Model<RecruitmentChannelBindingDocument>,
    @InjectModel(RecruitmentChannelInboxRecord.name)
    private readonly inbox: Model<RecruitmentChannelInboxDocument>,
    private readonly context: TenantContextService,
    private readonly crypto: RecruitmentDataCryptoService,
    private readonly registry: RecruitmentChannelRegistry,
    private readonly secrets: RecruitmentChannelSecretResolver,
    @InjectQueue(RECRUITMENT_CHANNEL_QUEUE)
    private readonly queue: Queue<RecruitmentChannelJobData>,
  ) {}

  /** 跨租户调度只领取绑定标识，具体拉取必须进入租户系统身份上下文。 */
  async enqueueDueBindings(limit = 100): Promise<number> {
    const now = new Date();
    let count = 0;
    for (let index = 0; index < Math.min(Math.max(limit, 1), 500); index += 1) {
      const reservedUntil = new Date(now.getTime() + POLL_EVERY_MS);
      const binding = await this.bindings.findOneAndUpdate(
        { status: 'active', nextPollAt: { $lte: now } },
        { $set: { nextPollAt: reservedUntil } },
        { returnDocument: 'after', sort: { nextPollAt: 1, id: 1 }, runValidators: true },
      ).lean().exec();
      if (binding === null) break;
      await this.queue.add(
        RECRUITMENT_CHANNEL_PULL_JOB,
        { tenantId: binding.tenantId, bindingId: binding.id },
        {
          jobId: digest(['pull', binding.tenantId, binding.id, reservedUntil.toISOString()]),
          attempts: 8, backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 1_000, removeOnFail: 10_000,
        },
      );
      count += 1;
    }
    return count;
  }

  async pullBinding(bindingId: string): Promise<number> {
    const trusted = this.context.getRequired();
    if (
      trusted.actor.actorType !== 'system_job' ||
      !trusted.actor.scopes.includes('erp:recruitment:channel:pull')
    ) throw new Error('RECRUITMENT_CHANNEL_WORKER_REQUIRED');
    const binding = await this.bindings.findOne({
      tenantId: trusted.tenant.tenantId, id: bindingId, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    try {
      const credential = this.secrets.resolve(binding.credentialSecretRef);
      const cursor = this.readCursor(binding);
      const result = await this.registry.adapter(binding.channelCode).pullApplications(
        credential,
        { tenantId: binding.tenantId, cursor, limit: PULL_LIMIT },
      );
      this.assertPullResult(result);
      for (const delivery of result.deliveries) await this.ingest(binding, delivery);
      const nextPollAt = new Date(Date.now() + (result.hasMore ? 1_000 : POLL_EVERY_MS));
      const cursorFields = this.protectCursor(binding, result.nextCursor);
      const updated = await this.bindings.updateOne(
        { tenantId: binding.tenantId, id: binding.id, status: 'active' },
        { $set: {
          ...cursorFields, lastPolledAt: new Date(), nextPollAt, lastFailureCode: null,
        } },
        { runValidators: true },
      );
      if (updated.matchedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_BINDING_LEASE_LOST');
      return result.deliveries.length;
    } catch (error) {
      const failed = await this.bindings.updateOne(
        { tenantId: binding.tenantId, id: binding.id, status: 'active' },
        { $set: {
          nextPollAt: new Date(Date.now() + FAILURE_RETRY_MS),
          lastFailureCode: failureCode(error),
        } },
        { runValidators: true },
      );
      if (failed.matchedCount !== 1) {
        throw new Error('RECRUITMENT_CHANNEL_BINDING_FAILURE_LEASE_LOST', { cause: error });
      }
      throw error;
    }
  }

  private async ingest(
    binding: RecruitmentChannelBindingRecord,
    delivery: {
      readonly externalEventId: string;
      readonly occurredAt: string;
      readonly payload: unknown;
    },
  ): Promise<void> {
    const eventBlindIndexes = this.crypto.channelFingerprints(
      binding.tenantId, 'event', binding.channelCode, delivery.externalEventId,
    );
    const existing = await this.inbox.findOne({
      tenantId: binding.tenantId, channelCode: binding.channelCode,
      eventBlindIndexes: { $in: [...eventBlindIndexes] },
    }).lean().exec();
    if (existing !== null) {
      await this.enqueueInbox(existing.tenantId, existing.id);
      return;
    }
    const inboxId = createEventId(new Date(delivery.occurredAt));
    const payload = this.crypto.protect({
      tenantId: binding.tenantId, resourceType: 'channel_inbox', resourceId: inboxId,
    }, delivery.payload);
    try {
      await this.inbox.create({
        id: inboxId, tenantId: binding.tenantId, bindingId: binding.id,
        channelCode: binding.channelCode, eventBlindIndexes: [...eventBlindIndexes],
        providerOccurredAt: new Date(delivery.occurredAt),
        payloadKeyId: payload.keyId, payloadIv: payload.iv,
        payloadCiphertext: payload.ciphertext, payloadAuthTag: payload.authTag,
        status: 'pending', attempts: 0, processingStartedAt: null, processedAt: null,
        failureCode: null, normalizerVersion: null, evidenceVerifiedAt: null, applicationId: null,
        consentEvidenceId: null, resumeSnapshotId: null,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.inbox.findOne({
        tenantId: binding.tenantId, channelCode: binding.channelCode,
        eventBlindIndexes: { $in: [...eventBlindIndexes] },
      }).lean().exec();
      if (raced === null) throw error;
      await this.enqueueInbox(raced.tenantId, raced.id);
      return;
    }
    await this.enqueueInbox(binding.tenantId, inboxId);
  }

  private async enqueueInbox(tenantId: string, inboxId: string): Promise<void> {
    const jobId = digest(['process', tenantId, inboxId]);
    const existing = await this.queue.getJob(jobId);
    if (existing !== undefined) {
      if (await existing.getState() === 'failed') await existing.retry();
      return;
    }
    await this.queue.add(
      RECRUITMENT_CHANNEL_PROCESS_JOB,
      { tenantId, inboxId },
      {
        jobId,
        attempts: 12, backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000, removeOnFail: 10_000,
      },
    );
  }

  private readCursor(binding: RecruitmentChannelBindingRecord): string | null {
    const cursorFields = [
      binding.cursorKeyId,
      binding.cursorIv,
      binding.cursorCiphertext,
      binding.cursorAuthTag,
    ];
    if (cursorFields.every((value) => value === null)) return null;
    if (
      binding.cursorKeyId === null ||
      binding.cursorIv === null ||
      binding.cursorCiphertext === null ||
      binding.cursorAuthTag === null
    ) {
      throw new Error('RECRUITMENT_CHANNEL_CURSOR_INVALID');
    }
    const value = this.crypto.unprotect({
      tenantId: binding.tenantId, resourceType: 'channel_cursor', resourceId: binding.id,
    }, {
      keyId: binding.cursorKeyId, iv: binding.cursorIv,
      ciphertext: binding.cursorCiphertext, authTag: binding.cursorAuthTag,
    });
    if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) {
      throw new Error('RECRUITMENT_CHANNEL_CURSOR_INVALID');
    }
    return value;
  }

  private protectCursor(
    binding: RecruitmentChannelBindingRecord,
    cursor: string | null,
  ): Readonly<Record<string, string | null>> {
    if (cursor === null) return {
      cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
    };
    if (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
      throw new Error('RECRUITMENT_CHANNEL_CURSOR_INVALID');
    }
    const protectedCursor = this.crypto.protect({
      tenantId: binding.tenantId, resourceType: 'channel_cursor', resourceId: binding.id,
    }, cursor);
    return {
      cursorKeyId: protectedCursor.keyId, cursorIv: protectedCursor.iv,
      cursorCiphertext: protectedCursor.ciphertext, cursorAuthTag: protectedCursor.authTag,
    };
  }

  private assertPullResult(result: {
    readonly deliveries: readonly {
      readonly externalEventId: string; readonly occurredAt: string; readonly payload: unknown;
    }[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }): void {
    if (result.deliveries.length > PULL_LIMIT || (result.hasMore && result.nextCursor === null)) {
      throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
    }
    for (const delivery of result.deliveries) {
      const occurredAt = Date.parse(delivery.occurredAt);
      if (
        delivery.externalEventId.length < 1 || delivery.externalEventId.length > 256 ||
        !Number.isFinite(occurredAt) || occurredAt > Date.now() + 5 * 60 * 1_000
      ) throw new Error('RECRUITMENT_CHANNEL_DELIVERY_INVALID');
    }
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
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
  return 'RECRUITMENT_CHANNEL_PULL_FAILED';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}

function unavailable(code: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ code, message: '招聘渠道凭据不可用' });
}
