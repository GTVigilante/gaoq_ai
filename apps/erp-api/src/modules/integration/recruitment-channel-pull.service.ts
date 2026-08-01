import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelRegistry,
  type RecruitmentChannelPullResult,
} from './recruitment-channel.adapter.js';
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
const MAX_DELIVERY_PAYLOAD_BYTES = 512 * 1_024;
const MAX_BATCH_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_ARRAY_ITEMS = 1_000;
const MAX_JSON_OBJECT_KEYS = 256;
const MAX_JSON_KEY_BYTES = 128;
const MAX_JSON_STRING_BYTES = 256 * 1_024;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
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
      this.assertActiveBinding(binding);
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
    this.assertActiveBinding(binding, {
      tenantId: trusted.tenant.tenantId,
      bindingId,
    });
    try {
      const credential = this.secrets.resolve(binding.credentialSecretRef);
      const cursor = this.readCursor(binding);
      const result = validatePullResult(
        await this.registry.adapter(binding.channelCode).pullApplications(
          credential,
          { tenantId: binding.tenantId, cursor, limit: PULL_LIMIT },
        ),
        cursor,
      );
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
      typeof binding.cursorKeyId !== 'string' ||
      typeof binding.cursorIv !== 'string' ||
      typeof binding.cursorCiphertext !== 'string' ||
      typeof binding.cursorAuthTag !== 'string'
    ) {
      throw new Error('RECRUITMENT_CHANNEL_CURSOR_INVALID');
    }
    const value = this.crypto.unprotect({
      tenantId: binding.tenantId, resourceType: 'channel_cursor', resourceId: binding.id,
    }, {
      keyId: binding.cursorKeyId, iv: binding.cursorIv,
      ciphertext: binding.cursorCiphertext, authTag: binding.cursorAuthTag,
    });
    if (!isCursor(value)) {
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
    if (!isCursor(cursor)) {
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

  private assertActiveBinding(
    binding: RecruitmentChannelBindingRecord,
    expected?: { readonly tenantId: string; readonly bindingId: string },
  ): void {
    if (
      typeof binding.id !== 'string' || !ULID_PATTERN.test(binding.id) ||
      typeof binding.tenantId !== 'string' || !TENANT_ID_PATTERN.test(binding.tenantId) ||
      typeof binding.channelCode !== 'string' || !CHANNEL_PATTERN.test(binding.channelCode) ||
      typeof binding.credentialSecretRef !== 'string' ||
      !SECRET_REF_PATTERN.test(binding.credentialSecretRef) ||
      binding.status !== 'active' ||
      !this.registry.supports(binding.channelCode) ||
      (expected !== undefined && (
        binding.tenantId !== expected.tenantId || binding.id !== expected.bindingId
      ))
    ) {
      throw new Error('RECRUITMENT_CHANNEL_BINDING_INVALID');
    }
  }
}

function validatePullResult(result: unknown, currentCursor: string | null): RecruitmentChannelPullResult {
  try {
    return validatePullResultUnsafe(result, currentCursor);
  } catch (error) {
    if (
      error instanceof Error &&
      /^RECRUITMENT_CHANNEL_[A-Z0-9_]{3,96}$/.test(error.message)
    ) throw error;
    throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID', { cause: error });
  }
}

function validatePullResultUnsafe(
  result: unknown,
  currentCursor: string | null,
): RecruitmentChannelPullResult {
  if (!hasExactKeys(result, ['deliveries', 'hasMore', 'nextCursor'])) {
    throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
  }
  const deliveries = result.deliveries;
  const nextCursor = result.nextCursor;
  const hasMore = result.hasMore;
  if (
    !Array.isArray(deliveries) || deliveries.length > PULL_LIMIT ||
    !hasDenseArrayShape(deliveries) ||
    typeof hasMore !== 'boolean' ||
    !(nextCursor === null || typeof nextCursor === 'string')
  ) throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
  if (nextCursor !== null && !isCursor(nextCursor)) {
    throw new Error('RECRUITMENT_CHANNEL_CURSOR_INVALID');
  }
  if (hasMore && nextCursor === null) {
    throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_INVALID');
  }
  if (hasMore && nextCursor === currentCursor) {
    throw new Error('RECRUITMENT_CHANNEL_CURSOR_STALLED');
  }

  const seenEventIds = new Set<string>();
  let batchPayloadBytes = 0;
  const validated = deliveries.map((delivery): RecruitmentChannelPullResult['deliveries'][number] => {
    if (!hasExactKeys(delivery, ['externalEventId', 'occurredAt', 'payload'])) {
      throw new Error('RECRUITMENT_CHANNEL_DELIVERY_INVALID');
    }
    if (
      typeof delivery.externalEventId !== 'string' ||
      !EXTERNAL_EVENT_ID_PATTERN.test(delivery.externalEventId) ||
      delivery.externalEventId.normalize('NFKC') !== delivery.externalEventId ||
      !isCanonicalInstant(delivery.occurredAt)
    ) throw new Error('RECRUITMENT_CHANNEL_DELIVERY_INVALID');
    if (seenEventIds.has(delivery.externalEventId)) {
      throw new Error('RECRUITMENT_CHANNEL_EVENT_DUPLICATE');
    }
    const occurredAt = Date.parse(delivery.occurredAt);
    if (occurredAt > Date.now() + 5 * 60 * 1_000) {
      throw new Error('RECRUITMENT_CHANNEL_DELIVERY_INVALID');
    }
    const payload = canonicalJsonPayload(delivery.payload);
    batchPayloadBytes += payload.bytes;
    if (batchPayloadBytes > MAX_BATCH_PAYLOAD_BYTES) {
      throw new Error('RECRUITMENT_CHANNEL_PULL_RESULT_TOO_LARGE');
    }
    seenEventIds.add(delivery.externalEventId);
    return Object.freeze({
      externalEventId: delivery.externalEventId,
      occurredAt: delivery.occurredAt,
      payload: payload.value,
    });
  });
  return Object.freeze({
    deliveries: Object.freeze(validated),
    nextCursor,
    hasMore,
  });
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const keys = ownKeys as readonly string[];
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || !descriptor.enumerable || !('value' in descriptor);
  })) return false;
  const sortedKeys = [...keys].sort();
  const wanted = [...expected].sort();
  return sortedKeys.length === wanted.length &&
    sortedKeys.every((key, index) => key === wanted[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCursor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalJsonPayload(value: unknown): { readonly value: unknown; readonly bytes: number } {
  if (!isPlainObject(value)) throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
  const budget = { nodes: 0 };
  assertJsonValue(value, 0, budget);
  const encoded = JSON.stringify(value);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_DELIVERY_PAYLOAD_BYTES) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_TOO_LARGE');
  }
  return Object.freeze({
    value: freezeJson(JSON.parse(encoded) as unknown),
    bytes,
  });
}

function assertJsonValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_TOO_COMPLEX');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_JSON_STRING_BYTES) {
      throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_TOO_LARGE');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
    }
    return;
  }
  if (Array.isArray(value)) {
    assertJsonArray(value, depth, budget);
    return;
  }
  if (!isPlainObject(value)) throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_JSON_OBJECT_KEYS) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_TOO_COMPLEX');
  }
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
  }
  for (const key of keys as readonly string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) ||
      key === '__proto__' || key === 'prototype' || key === 'constructor' ||
      key.normalize('NFKC') !== key || Buffer.byteLength(key, 'utf8') > MAX_JSON_KEY_BYTES ||
      hasUnsafeText(key)
    ) throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
    assertJsonValue(descriptor.value, depth + 1, budget);
  }
}

function assertJsonArray(
  value: readonly unknown[],
  depth: number,
  budget: { nodes: number },
): void {
  if (value.length > MAX_JSON_ARRAY_ITEMS) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_TOO_COMPLEX');
  }
  if (!hasDenseArrayShape(value)) {
    throw new Error('RECRUITMENT_CHANNEL_PAYLOAD_INVALID');
  }
  for (let index = 0; index < value.length; index += 1) {
    assertJsonValue(value[index], depth + 1, budget);
  }
}

function hasDenseArrayShape(value: readonly unknown[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
  }
  return true;
}

function hasUnsafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined || code <= 0x1f || code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) return true;
  }
  return false;
}

function freezeJson(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeJson(item);
  }
  return Object.freeze(value);
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
