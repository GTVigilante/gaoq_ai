import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import { AttendanceProviderRegistry, type AttendanceProviderRawEvent } from './attendance-provider.adapter.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxRecord,
  type AttendanceProviderInboxDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';
import {
  ATTENDANCE_PROVIDER_PROCESS_JOB,
  ATTENDANCE_PROVIDER_PULL_JOB,
  ATTENDANCE_PROVIDER_QUEUE,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';

const POLL_EVERY_MS = 5 * 60 * 1_000;
const FAILURE_RETRY_MS = 60 * 1_000;
const POLL_LEASE_MS = 30 * 60 * 1_000;
const MAPPING_PAGE_SIZE = 100;
const PROVIDER_BATCH_SIZE = 20;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface AttendanceProviderCursor {
  readonly throughDate: string;
  readonly windowToDate: string | null;
  readonly employeeAfterId: string | null;
}

@Injectable()
export class AttendanceProviderPullService {
  constructor(
    @InjectModel(AttendanceProviderStateRecord.name)
    private readonly states: Model<AttendanceProviderStateDocument>,
    @InjectModel(AttendanceProviderEmployeeMappingRecord.name)
    private readonly mappings: Model<AttendanceProviderEmployeeMappingDocument>,
    @InjectModel(AttendanceProviderInboxRecord.name)
    private readonly inbox: Model<AttendanceProviderInboxDocument>,
    private readonly context: TenantContextService,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly registry: AttendanceProviderRegistry,
    @InjectQueue(ATTENDANCE_PROVIDER_QUEUE)
    private readonly queue: Queue<AttendanceProviderJobData>,
  ) {}

  async enqueueDueStates(limit = 100): Promise<number> {
    const due = await this.states.find(
      { status: 'active', nextPollAt: { $lte: new Date() } },
      { tenantId: 1, id: 1, nextPollAt: 1, _id: 0 },
    ).sort({ nextPollAt: 1, id: 1 }).limit(limit).lean().exec();
    for (const state of due) {
      const jobId = digest(['pull', state.tenantId, state.id, state.nextPollAt.toISOString()]);
      const existing = await this.queue.getJob(jobId);
      if (existing !== undefined) {
        if (await existing.getState() === 'failed') await existing.retry();
        continue;
      }
      await this.queue.add(
        ATTENDANCE_PROVIDER_PULL_JOB,
        { tenantId: state.tenantId, stateId: state.id },
        {
          jobId, attempts: 8, backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000, removeOnFail: 10_000,
        },
      );
    }
    return due.length;
  }

  async pullState(stateId: string): Promise<number> {
    const trusted = this.context.getRequired();
    if (
      trusted.actor.actorType !== 'system_job' ||
      !trusted.actor.scopes.includes('erp:attendance:provider:pull')
    ) throw new Error('ATTENDANCE_PROVIDER_WORKER_REQUIRED');
    const leaseUntil = new Date(Date.now() + POLL_LEASE_MS);
    const state = await this.states.findOneAndUpdate(
      {
        tenantId: trusted.tenant.tenantId, id: stateId, status: 'active',
        nextPollAt: { $lte: new Date() },
      },
      { $set: { nextPollAt: leaseUntil } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (state === null) return 0;
    try {
      const today = businessDate(new Date(), state.timeZone);
      const cursor = this.readCursor(state) ?? {
        throughDate: shiftDate(today, -1), windowToDate: null, employeeAfterId: null,
      };
      const fromDate = cursor.throughDate;
      const toDate = cursor.windowToDate ?? minDate(shiftDate(fromDate, 6), today);
      const records = await this.mappings.find({
        tenantId: state.tenantId, providerCode: state.providerCode, status: 'active',
        ...(cursor.employeeAfterId === null ? {} : { id: { $gt: cursor.employeeAfterId } }),
      }).sort({ id: 1 }).limit(MAPPING_PAGE_SIZE + 1).lean().exec();
      if (records.length === 0 && cursor.employeeAfterId === null) {
        throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING');
      }
      const page = records.slice(0, MAPPING_PAGE_SIZE);
      const hasMoreMappings = records.length > MAPPING_PAGE_SIZE;
      const externalEmployeeIds = page.map((mapping) => this.readExternalEmployeeId(mapping));
      let count = 0;
      for (let index = 0; index < externalEmployeeIds.length; index += PROVIDER_BATCH_SIZE) {
        const events = await this.registry.adapter(state.providerCode).pullBatch({
          tenantId: state.tenantId,
          externalEmployeeIds: externalEmployeeIds.slice(index, index + PROVIDER_BATCH_SIZE),
          fromDate, toDate, timeZone: state.timeZone,
        });
        for (const event of events) await this.ingest(state, event);
        count += events.length;
      }
      const lastMapping = page.at(-1);
      if (hasMoreMappings && lastMapping === undefined) {
        throw new Error('ATTENDANCE_PROVIDER_MAPPING_PAGE_INVALID');
      }
      const nextCursor: AttendanceProviderCursor = hasMoreMappings
        ? {
            throughDate: fromDate, windowToDate: toDate,
            employeeAfterId: lastMapping?.id ?? null,
          }
        : { throughDate: toDate, windowToDate: null, employeeAfterId: null };
      const protectedCursor = this.protectCursor(state, nextCursor);
      const updated = await this.states.updateOne(
        {
          tenantId: state.tenantId, id: state.id, status: 'active', nextPollAt: leaseUntil,
        },
        { $set: {
          ...protectedCursor, lastPolledAt: new Date(),
          nextPollAt: new Date(Date.now() + (hasMoreMappings ? 1_000 : POLL_EVERY_MS)),
          lastFailureCode: null,
        } },
        { runValidators: true },
      );
      if (updated.matchedCount !== 1) throw new Error('ATTENDANCE_PROVIDER_STATE_LEASE_LOST');
      return count;
    } catch (error) {
      const failed = await this.states.updateOne(
        {
          tenantId: state.tenantId, id: state.id, status: 'active', nextPollAt: leaseUntil,
        },
        { $set: {
          nextPollAt: new Date(Date.now() + FAILURE_RETRY_MS), lastFailureCode: failureCode(error),
        } },
        { runValidators: true },
      );
      if (failed.matchedCount !== 1) {
        throw new Error('ATTENDANCE_PROVIDER_STATE_LEASE_LOST', { cause: error });
      }
      throw error;
    }
  }

  private async ingest(
    state: AttendanceProviderStateRecord,
    event: AttendanceProviderRawEvent,
  ): Promise<void> {
    const eventBlindIndexes = this.crypto.providerFingerprints(
      state.tenantId, 'event', state.providerCode, event.externalEventId,
    );
    const existing = await this.inbox.findOne({
      tenantId: state.tenantId, providerCode: state.providerCode,
      eventBlindIndexes: { $in: [...eventBlindIndexes] },
    }).lean().exec();
    if (existing !== null) {
      this.assertSameEvent(existing, event);
      await this.enqueueInbox(existing.tenantId, existing.id);
      return;
    }
    const inboxId = createEventId(new Date(event.occurredAt));
    const protectedPayload = this.crypto.protect({
      tenantId: state.tenantId, resourceType: 'provider_inbox', resourceId: inboxId,
    }, { payload: event.payload, transportRequestId: event.transportRequestId });
    try {
      await this.inbox.create({
        id: inboxId, tenantId: state.tenantId, stateId: state.id,
        providerCode: state.providerCode, eventBlindIndexes: [...eventBlindIndexes],
        providerOccurredAt: new Date(event.occurredAt),
        payloadKeyId: protectedPayload.keyId, payloadIv: protectedPayload.iv,
        payloadCiphertext: protectedPayload.ciphertext, payloadAuthTag: protectedPayload.authTag,
        transportRequestIdFingerprint: digest(['request', event.transportRequestId]),
        status: 'pending', attempts: 0, processingStartedAt: null, processedAt: null,
        failureCode: null, normalizerVersion: null, evidenceVerifiedAt: null, sourceFactId: null,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.inbox.findOne({
        tenantId: state.tenantId, providerCode: state.providerCode,
        eventBlindIndexes: { $in: [...eventBlindIndexes] },
      }).lean().exec();
      if (raced === null) throw error;
      await this.enqueueInbox(raced.tenantId, raced.id);
      return;
    }
    await this.enqueueInbox(state.tenantId, inboxId);
  }

  private async enqueueInbox(tenantId: string, inboxId: string): Promise<void> {
    const jobId = digest(['process', tenantId, inboxId]);
    const existing = await this.queue.getJob(jobId);
    if (existing !== undefined) {
      if (await existing.getState() === 'failed') await existing.retry();
      return;
    }
    await this.queue.add(
      ATTENDANCE_PROVIDER_PROCESS_JOB, { tenantId, inboxId },
      {
        jobId, attempts: 12, backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000, removeOnFail: 10_000,
      },
    );
  }

  private assertSameEvent(
    existing: AttendanceProviderInboxRecord,
    incoming: AttendanceProviderRawEvent,
  ): void {
    const decrypted = this.crypto.unprotect({
      tenantId: existing.tenantId, resourceType: 'provider_inbox', resourceId: existing.id,
    }, {
      keyId: existing.payloadKeyId, iv: existing.payloadIv,
      ciphertext: existing.payloadCiphertext, authTag: existing.payloadAuthTag,
    });
    const envelope = z.object({ payload: z.unknown(), transportRequestId: z.string() })
      .strict().parse(decrypted);
    if (
      existing.providerOccurredAt.toISOString() !== new Date(incoming.occurredAt).toISOString() ||
      canonicalProviderPayload(envelope.payload) !== canonicalProviderPayload(incoming.payload)
    ) throw new Error('ATTENDANCE_PROVIDER_EVENT_PAYLOAD_COLLISION');
  }

  private readExternalEmployeeId(mapping: AttendanceProviderEmployeeMappingRecord): string {
    const value = this.crypto.unprotect({
      tenantId: mapping.tenantId, resourceType: 'provider_mapping', resourceId: mapping.id,
    }, {
      keyId: mapping.externalIdKeyId, iv: mapping.externalIdIv,
      ciphertext: mapping.externalIdCiphertext, authTag: mapping.externalIdAuthTag,
    });
    return z.string().min(1).max(256).parse(value);
  }

  private readCursor(state: AttendanceProviderStateRecord): AttendanceProviderCursor | null {
    if (
      state.cursorKeyId === null || state.cursorIv === null ||
      state.cursorCiphertext === null || state.cursorAuthTag === null
    ) return null;
    const value = this.crypto.unprotect({
      tenantId: state.tenantId, resourceType: 'provider_cursor', resourceId: state.id,
    }, {
      keyId: state.cursorKeyId, iv: state.cursorIv,
      ciphertext: state.cursorCiphertext, authTag: state.cursorAuthTag,
    });
    if (typeof value === 'string' && DATE_PATTERN.test(value)) {
      return { throughDate: value, windowToDate: null, employeeAfterId: null };
    }
    const parsed = z.object({
      throughDate: z.string().regex(DATE_PATTERN),
      windowToDate: z.string().regex(DATE_PATTERN).nullable(),
      employeeAfterId: z.string().regex(ID_PATTERN).nullable(),
    }).strict().safeParse(value);
    if (!parsed.success || (
      (parsed.data.employeeAfterId === null) !== (parsed.data.windowToDate === null)
    )) throw new Error('ATTENDANCE_PROVIDER_CURSOR_INVALID');
    return parsed.data;
  }

  private protectCursor(
    state: AttendanceProviderStateRecord,
    cursor: AttendanceProviderCursor,
  ): Readonly<Record<string, string>> {
    if (!DATE_PATTERN.test(cursor.throughDate)) throw new Error('ATTENDANCE_PROVIDER_CURSOR_INVALID');
    const value = this.crypto.protect({
      tenantId: state.tenantId, resourceType: 'provider_cursor', resourceId: state.id,
    }, cursor);
    return {
      cursorKeyId: value.keyId, cursorIv: value.iv,
      cursorCiphertext: value.ciphertext, cursorAuthTag: value.authTag,
    };
  }
}

function businessDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function canonicalProviderPayload(value: unknown, depth = 0): string {
  if (depth > 20) throw new Error('ATTENDANCE_PROVIDER_PAYLOAD_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ATTENDANCE_PROVIDER_PAYLOAD_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error('ATTENDANCE_PROVIDER_PAYLOAD_TOO_LARGE');
    return `[${value.map((item) => canonicalProviderPayload(item, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('ATTENDANCE_PROVIDER_PAYLOAD_INVALID');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'pulledAt')
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalProviderPayload(item, depth + 1)}`).join(',')}}`;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'ATTENDANCE_PROVIDER_PULL_FAILED';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
