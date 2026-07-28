import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { AttendanceFactType, AttendanceImpact } from '../attendance/domain/index.js';
import {
  OrgPlatformHttpClient,
  type OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

export type AttendanceProviderCode = 'dingtalk' | 'feishu';

export interface AttendanceProviderRawEvent {
  readonly externalEventId: string;
  readonly occurredAt: string;
  readonly transportRequestId: string;
  readonly payload: unknown;
}

export interface AttendanceProviderPullInput {
  readonly tenantId: string;
  readonly externalEmployeeIds: readonly string[];
  readonly fromDate: string;
  readonly toDate: string;
  readonly timeZone: string;
}

export interface NormalizedAttendanceProviderFact {
  readonly externalEmployeeId: string;
  readonly externalEventId: string;
  readonly factType: AttendanceFactType;
  readonly occurredAt: string;
  readonly timeZone: string;
  readonly impact: AttendanceImpact;
  readonly sourceObservedAt: string;
}

export abstract class AttendanceProviderAdapter {
  abstract readonly providerCode: AttendanceProviderCode;
  abstract pullBatch(input: AttendanceProviderPullInput): Promise<readonly AttendanceProviderRawEvent[]>;
}

export abstract class AttendanceProviderNormalizer {
  abstract readonly providerCode: AttendanceProviderCode;
  abstract readonly schemaVersion: string;
  abstract normalize(payload: unknown, timeZone: string): NormalizedAttendanceProviderFact;
}

export abstract class AttendanceProviderEvidenceVerifier {
  abstract readonly providerCode: AttendanceProviderCode;
  abstract verify(payload: unknown, transportRequestId: string): boolean;
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const PULL_INPUT_KEYS =
  'externalEmployeeIds,fromDate,tenantId,timeZone,toDate';
const providerIdSchema = z.string().min(1).max(256)
  .refine((value) => isProviderId(value));

@Injectable()
export class AttendanceProviderRegistry {
  private readonly adapters: ReadonlyMap<string, AttendanceProviderAdapter>;
  private readonly normalizers: ReadonlyMap<string, AttendanceProviderNormalizer>;
  private readonly verifiers: ReadonlyMap<string, AttendanceProviderEvidenceVerifier>;

  constructor(
    adapters: readonly AttendanceProviderAdapter[],
    normalizers: readonly AttendanceProviderNormalizer[],
    verifiers: readonly AttendanceProviderEvidenceVerifier[],
  ) {
    this.adapters = uniqueByCode(adapters, 'ATTENDANCE_PROVIDER_ADAPTER_DUPLICATE');
    this.normalizers = uniqueByCode(normalizers, 'ATTENDANCE_PROVIDER_NORMALIZER_DUPLICATE');
    this.verifiers = uniqueByCode(verifiers, 'ATTENDANCE_PROVIDER_VERIFIER_DUPLICATE');
    for (const code of ['dingtalk', 'feishu']) {
      if (!this.adapters.has(code) || !this.normalizers.has(code) || !this.verifiers.has(code)) {
        throw new Error('ATTENDANCE_PROVIDER_REGISTRY_INCOMPLETE');
      }
    }
  }

  adapter(code: AttendanceProviderCode): AttendanceProviderAdapter {
    return required(this.adapters, code, 'ATTENDANCE_PROVIDER_ADAPTER_MISSING');
  }

  normalizer(code: AttendanceProviderCode): AttendanceProviderNormalizer {
    return required(this.normalizers, code, 'ATTENDANCE_PROVIDER_NORMALIZER_MISSING');
  }

  verifier(code: AttendanceProviderCode): AttendanceProviderEvidenceVerifier {
    return required(this.verifiers, code, 'ATTENDANCE_PROVIDER_VERIFIER_MISSING');
  }
}

const dingtalkResponseSchema = z.object({
  errcode: z.number().int(),
  request_id: z.string().regex(REQUEST_ID_PATTERN).optional(),
  recordresult: z.array(z.object({
    id: z.union([providerIdSchema, z.number().int().nonnegative()]),
    userId: providerIdSchema,
    userCheckTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
    checkType: z.enum(['OnDuty', 'OffDuty']),
  }).passthrough()).max(10_000).optional(),
}).passthrough();

const dingtalkEnvelopeSchema = z.object({
  providerCode: z.literal('dingtalk'),
  externalEventId: providerIdSchema,
  pulledAt: z.string().datetime({ offset: true }),
  record: dingtalkResponseSchema.shape.recordresult.unwrap().element,
}).strict().superRefine((value, context) => {
  if (String(value.record.id) !== value.externalEventId) {
    context.addIssue({ code: 'custom', message: '钉钉事件标识与原始记录不一致' });
  }
});

/** 钉钉实际打卡记录适配器：单批最多 50 人、单窗口最多 7 个自然日。 */
@Injectable()
export class DingTalkAttendanceProvider extends AttendanceProviderAdapter
  implements AttendanceProviderNormalizer, AttendanceProviderEvidenceVerifier {
  readonly providerCode = 'dingtalk' as const;
  readonly schemaVersion = 'dingtalk-list-record-v2';

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) { super(); }

  async pullBatch(input: AttendanceProviderPullInput): Promise<readonly AttendanceProviderRawEvent[]> {
    assertPullInput(input);
    if (input.timeZone !== 'Asia/Shanghai') {
      throw new Error('ATTENDANCE_DINGTALK_TIME_ZONE_UNSUPPORTED');
    }
    const response = await this.call(input.tenantId, {
        userIds: [...input.externalEmployeeIds],
        checkDateFrom: localBoundary(input.fromDate, false),
        checkDateTo: localBoundary(input.toDate, true),
        isI18n: true,
    });
    const parsed = dingtalkResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.errcode !== 0) {
      throw new Error('ATTENDANCE_DINGTALK_RESPONSE_INVALID');
    }
    const requestId = requireRequestId(response.requestId ?? parsed.data.request_id);
    const pulledAt = new Date().toISOString();
    const requestedEmployeeIds = new Set(input.externalEmployeeIds);
    const seenEventIds = new Set<string>();
    return Object.freeze((parsed.data.recordresult ?? []).map((record) => {
      const externalEventId = String(record.id);
      const occurredAt = epochMillis(record.userCheckTime);
      assertPulledEvent({
        externalEmployeeId: record.userId,
        externalEventId,
        occurredAt,
        requestedEmployeeIds,
        seenEventIds,
        fromDate: input.fromDate,
        toDate: input.toDate,
        timeZone: input.timeZone,
      });
      return Object.freeze({
        externalEventId,
        occurredAt: occurredAt.toISOString(),
        transportRequestId: requestId,
        payload: Object.freeze({ providerCode: this.providerCode, externalEventId, pulledAt, record }),
      });
    }));
  }

  normalize(payload: unknown, timeZone: string): NormalizedAttendanceProviderFact {
    assertTimeZone(timeZone);
    const envelope = dingtalkEnvelopeSchema.parse(payload);
    const occurredAt = epochMillis(envelope.record.userCheckTime).toISOString();
    return normalized({
      externalEmployeeId: envelope.record.userId,
      externalEventId: envelope.externalEventId,
      factType: envelope.record.checkType === 'OnDuty' ? 'punch_in' : 'punch_out',
      occurredAt, timeZone, sourceObservedAt: envelope.pulledAt,
    });
  }

  verify(payload: unknown, transportRequestId: string): boolean {
    if (!REQUEST_ID_PATTERN.test(transportRequestId)) return false;
    const envelope = dingtalkEnvelopeSchema.safeParse(payload);
    if (!envelope.success) return false;
    try {
      return evidenceTimelineIsValid(
        epochMillis(envelope.data.record.userCheckTime),
        envelope.data.pulledAt,
      );
    } catch {
      return false;
    }
  }

  private async call(
    tenantId: string,
    body: Readonly<Record<string, unknown>>,
    allowTokenRefresh = true,
  ): Promise<OrgPlatformHttpResponse> {
    const access = await this.tokens.getAccess(tenantId, this.providerCode);
    try {
      return await this.http.request({
        origin: 'https://oapi.dingtalk.com', path: '/attendance/listRecord', method: 'POST',
        sensitiveQuery: { access_token: access.accessToken }, body,
      });
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(tenantId, this.providerCode, access.accessToken);
        return this.call(tenantId, body, false);
      }
      throw error;
    }
  }
}

const feishuRecordSchema = z.object({
  user_id: providerIdSchema,
  check_time: z.string().regex(/^\d{1,12}$/),
  record_id: providerIdSchema.optional(),
}).passthrough();
const feishuResponseSchema = z.object({
  code: z.number().int(),
  request_id: z.string().regex(REQUEST_ID_PATTERN).optional(),
  data: z.object({
    user_task_results: z.array(z.object({
      result_id: providerIdSchema,
      user_id: providerIdSchema,
      records: z.array(z.object({
        check_in_record_id: z.string().max(256),
        check_in_record: feishuRecordSchema.optional(),
        check_out_record_id: z.string().max(256),
        check_out_record: feishuRecordSchema.optional(),
      }).passthrough()).max(32),
    }).passthrough()).max(10_000).optional(),
    invalid_user_ids: z.array(providerIdSchema).max(50).optional(),
    unauthorized_user_ids: z.array(providerIdSchema).max(50).optional(),
  }).passthrough().optional(),
}).passthrough();
const feishuEnvelopeSchema = z.object({
  providerCode: z.literal('feishu'),
  externalEventId: providerIdSchema,
  direction: z.enum(['in', 'out']),
  pulledAt: z.string().datetime({ offset: true }),
  record: feishuRecordSchema,
  source: z.object({
    resultId: providerIdSchema,
    slotIndex: z.number().int().min(0).max(31),
    providerRecordId: z.string().max(256),
  }).strict(),
}).strict().superRefine((value, context) => {
  let expected: string;
  try {
    expected = feishuEventId(
      value.record,
      value.source.providerRecordId,
      value.source.resultId,
      value.direction,
      value.source.slotIndex,
    );
  } catch {
    context.addIssue({ code: 'custom', message: '飞书原始记录标识互相冲突' });
    return;
  }
  if (expected !== value.externalEventId) {
    context.addIssue({ code: 'custom', message: '飞书事件标识与原始记录不一致' });
  }
});

/** 飞书打卡结果适配器：只读取自建应用授权范围内员工，未授权员工导致整批失败关闭。 */
@Injectable()
export class FeishuAttendanceProvider extends AttendanceProviderAdapter
  implements AttendanceProviderNormalizer, AttendanceProviderEvidenceVerifier {
  readonly providerCode = 'feishu' as const;
  readonly schemaVersion = 'feishu-user-task-v2';

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) { super(); }

  async pullBatch(input: AttendanceProviderPullInput): Promise<readonly AttendanceProviderRawEvent[]> {
    assertPullInput(input);
    const response = await this.call(input.tenantId, {
        user_ids: [...input.externalEmployeeIds],
        check_date_from: Number(input.fromDate.replaceAll('-', '')),
        check_date_to: Number(input.toDate.replaceAll('-', '')),
        need_overtime_result: false,
    });
    const parsed = feishuResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.code !== 0 || parsed.data.data === undefined) {
      throw new Error('ATTENDANCE_FEISHU_RESPONSE_INVALID');
    }
    if (
      (parsed.data.data.invalid_user_ids?.length ?? 0) > 0 ||
      (parsed.data.data.unauthorized_user_ids?.length ?? 0) > 0
    ) throw new Error('ATTENDANCE_FEISHU_EMPLOYEE_SCOPE_MISMATCH');
    const requestId = requireRequestId(response.requestId ?? parsed.data.request_id);
    const pulledAt = new Date().toISOString();
    const events: AttendanceProviderRawEvent[] = [];
    const requestedEmployeeIds = new Set(input.externalEmployeeIds);
    const seenEventIds = new Set<string>();
    const seenTaskIds = new Set<string>();
    for (const task of parsed.data.data.user_task_results ?? []) {
      if (!requestedEmployeeIds.has(task.user_id)) {
        throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH');
      }
      if (seenTaskIds.has(task.result_id)) {
        throw new Error('ATTENDANCE_FEISHU_TASK_DUPLICATE');
      }
      seenTaskIds.add(task.result_id);
      task.records.forEach((slot, slotIndex) => {
        for (const [direction, record, recordId] of [
          ['in', slot.check_in_record, slot.check_in_record_id],
          ['out', slot.check_out_record, slot.check_out_record_id],
        ] as const) {
          if (record === undefined) continue;
          if (record.user_id !== task.user_id) {
            throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH');
          }
          const externalEventId = feishuEventId(
            record,
            recordId,
            task.result_id,
            direction,
            slotIndex,
          );
          const occurredAt = epochSeconds(record.check_time);
          assertPulledEvent({
            externalEmployeeId: record.user_id,
            externalEventId,
            occurredAt,
            requestedEmployeeIds,
            seenEventIds,
            fromDate: input.fromDate,
            toDate: input.toDate,
            timeZone: input.timeZone,
          });
          events.push(Object.freeze({
            externalEventId,
            occurredAt: occurredAt.toISOString(),
            transportRequestId: requestId,
            payload: Object.freeze({
              providerCode: this.providerCode,
              externalEventId,
              direction,
              pulledAt,
              record,
              source: Object.freeze({
                resultId: task.result_id,
                slotIndex,
                providerRecordId: recordId,
              }),
            }),
          }));
        }
      });
    }
    return Object.freeze(events);
  }

  normalize(payload: unknown, timeZone: string): NormalizedAttendanceProviderFact {
    assertTimeZone(timeZone);
    const envelope = feishuEnvelopeSchema.parse(payload);
    return normalized({
      externalEmployeeId: envelope.record.user_id,
      externalEventId: envelope.externalEventId,
      factType: envelope.direction === 'in' ? 'punch_in' : 'punch_out',
      occurredAt: epochSeconds(envelope.record.check_time).toISOString(),
      timeZone, sourceObservedAt: envelope.pulledAt,
    });
  }

  verify(payload: unknown, transportRequestId: string): boolean {
    if (!REQUEST_ID_PATTERN.test(transportRequestId)) return false;
    const envelope = feishuEnvelopeSchema.safeParse(payload);
    if (!envelope.success) return false;
    try {
      return evidenceTimelineIsValid(
        epochSeconds(envelope.data.record.check_time),
        envelope.data.pulledAt,
      );
    } catch {
      return false;
    }
  }

  private async call(
    tenantId: string,
    body: Readonly<Record<string, unknown>>,
    allowTokenRefresh = true,
  ): Promise<OrgPlatformHttpResponse> {
    const access = await this.tokens.getAccess(tenantId, this.providerCode);
    try {
      return await this.http.request({
        origin: 'https://open.feishu.cn', path: '/open-apis/attendance/v1/user_tasks/query',
        method: 'POST', headers: { authorization: `Bearer ${access.accessToken}` },
        query: { employee_type: 'employee_id', ignore_invalid_users: false }, body,
      });
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(tenantId, this.providerCode, access.accessToken);
        return this.call(tenantId, body, false);
      }
      throw error;
    }
  }
}

function normalized(
  input: Omit<NormalizedAttendanceProviderFact, 'impact'>,
): NormalizedAttendanceProviderFact {
  return Object.freeze({
    ...input,
    impact: Object.freeze({ workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 }),
  });
}

function assertPullInput(input: AttendanceProviderPullInput): void {
  if (
    Object.keys(input).sort().join(',') !== PULL_INPUT_KEYS ||
    !TENANT_ID_PATTERN.test(input.tenantId) ||
    !Array.isArray(input.externalEmployeeIds) ||
    input.externalEmployeeIds.length < 1 ||
    input.externalEmployeeIds.length > 50 ||
    input.externalEmployeeIds.some((id) => !isProviderId(id)) ||
    new Set(input.externalEmployeeIds).size !== input.externalEmployeeIds.length
  ) {
    throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_BATCH_INVALID');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.toDate)) {
    throw new Error('ATTENDANCE_PROVIDER_WINDOW_INVALID');
  }
  const from = Date.parse(`${input.fromDate}T00:00:00Z`);
  const to = Date.parse(`${input.toDate}T00:00:00Z`);
  if (
    !Number.isFinite(from) || !Number.isFinite(to) || to < from ||
    to - from > 6 * 24 * 60 * 60 * 1_000 ||
    new Date(from).toISOString().slice(0, 10) !== input.fromDate ||
    new Date(to).toISOString().slice(0, 10) !== input.toDate
  ) throw new Error('ATTENDANCE_PROVIDER_WINDOW_INVALID');
  assertTimeZone(input.timeZone);
}

function localBoundary(date: string, end: boolean): string {
  return `${date} ${end ? '23:59:59' : '00:00:00'}`;
}

function epochMillis(value: string | number): Date {
  const instant = new Date(Number(value));
  if (!Number.isFinite(instant.getTime())) throw new Error('ATTENDANCE_PROVIDER_TIME_INVALID');
  return instant;
}

function epochSeconds(value: string): Date {
  return epochMillis(Number(value) * 1_000);
}

function requireRequestId(value: string | undefined): string {
  if (value === undefined || !REQUEST_ID_PATTERN.test(value)) {
    throw new Error('ATTENDANCE_PROVIDER_REQUEST_ID_MISSING');
  }
  return value;
}

function isProviderId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.normalize('NFKC') === value &&
    !/[\p{Cc}\p{Cf}\p{Z}]/u.test(value);
}

function assertTimeZone(timeZone: string): void {
  if (
    typeof timeZone !== 'string' ||
    timeZone.length < 1 ||
    timeZone.length > 128 ||
    /[\p{Cc}\p{Cf}\p{Z}]/u.test(timeZone)
  ) throw new Error('ATTENDANCE_PROVIDER_TIME_ZONE_INVALID');
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
  } catch {
    throw new Error('ATTENDANCE_PROVIDER_TIME_ZONE_INVALID');
  }
}

function assertPulledEvent(input: {
  readonly externalEmployeeId: string;
  readonly externalEventId: string;
  readonly occurredAt: Date;
  readonly requestedEmployeeIds: ReadonlySet<string>;
  readonly seenEventIds: Set<string>;
  readonly fromDate: string;
  readonly toDate: string;
  readonly timeZone: string;
}): void {
  if (!input.requestedEmployeeIds.has(input.externalEmployeeId)) {
    throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH');
  }
  if (!isProviderId(input.externalEventId)) {
    throw new Error('ATTENDANCE_PROVIDER_EVENT_ID_INVALID');
  }
  if (input.seenEventIds.has(input.externalEventId)) {
    throw new Error('ATTENDANCE_PROVIDER_EVENT_DUPLICATE');
  }
  const localDate = dateInTimeZone(input.occurredAt, input.timeZone);
  if (localDate < input.fromDate || localDate > input.toDate) {
    throw new Error('ATTENDANCE_PROVIDER_EVENT_WINDOW_MISMATCH');
  }
  input.seenEventIds.add(input.externalEventId);
}

function dateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value['year']}-${value['month']}-${value['day']}`;
}

function evidenceTimelineIsValid(occurredAt: Date, pulledAtValue: string): boolean {
  const pulledAt = new Date(pulledAtValue);
  const now = Date.now();
  return Number.isFinite(occurredAt.getTime()) &&
    Number.isFinite(pulledAt.getTime()) &&
    pulledAt.toISOString() === pulledAtValue &&
    pulledAt.getTime() <= now + MAX_CLOCK_SKEW_MS &&
    occurredAt.getTime() <= pulledAt.getTime() + MAX_CLOCK_SKEW_MS;
}

function feishuEventId(
  record: z.infer<typeof feishuRecordSchema>,
  providerRecordId: string,
  resultId: string,
  direction: 'in' | 'out',
  slotIndex: number,
): string {
  if (
    record.record_id !== undefined &&
    providerRecordId.length > 0 &&
    record.record_id !== providerRecordId
  ) throw new Error('ATTENDANCE_FEISHU_RECORD_ID_MISMATCH');
  if (record.record_id !== undefined) return record.record_id;
  if (providerRecordId.length > 0) {
    if (!isProviderId(providerRecordId)) {
      throw new Error('ATTENDANCE_PROVIDER_EVENT_ID_INVALID');
    }
    return providerRecordId;
  }
  return `derived:${createHash('sha256').update(JSON.stringify([
    'feishu-attendance-event-v1',
    resultId,
    direction,
    slotIndex,
  ])).digest('base64url')}`;
}

function uniqueByCode<T extends { readonly providerCode: string }>(
  values: readonly T[], code: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.providerCode)) throw new Error(code);
    result.set(value.providerCode, value);
  }
  return result;
}

function required<T>(values: ReadonlyMap<string, T>, key: string, code: string): T {
  const value = values.get(key);
  if (value === undefined) throw new Error(code);
  return value;
}
