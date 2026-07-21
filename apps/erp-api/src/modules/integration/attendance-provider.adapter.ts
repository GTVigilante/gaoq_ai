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
  request_id: z.string().min(8).max(256).optional(),
  recordresult: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    userId: z.string().min(1).max(256),
    userCheckTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
    checkType: z.enum(['OnDuty', 'OffDuty']),
  }).passthrough()).max(10_000).optional(),
}).passthrough();

const dingtalkEnvelopeSchema = z.object({
  providerCode: z.literal('dingtalk'),
  externalEventId: z.string().min(1).max(256),
  pulledAt: z.string().datetime({ offset: true }),
  record: dingtalkResponseSchema.shape.recordresult.unwrap().element,
}).strict();

/** 钉钉实际打卡记录适配器：单批最多 50 人、单窗口最多 7 个自然日。 */
@Injectable()
export class DingTalkAttendanceProvider extends AttendanceProviderAdapter
  implements AttendanceProviderNormalizer, AttendanceProviderEvidenceVerifier {
  readonly providerCode = 'dingtalk' as const;
  readonly schemaVersion = 'dingtalk-list-record-v1';

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
    return Object.freeze((parsed.data.recordresult ?? []).map((record) => {
      const externalEventId = String(record.id);
      return Object.freeze({
        externalEventId,
        occurredAt: epochMillis(record.userCheckTime).toISOString(),
        transportRequestId: requestId,
        payload: Object.freeze({ providerCode: this.providerCode, externalEventId, pulledAt, record }),
      });
    }));
  }

  normalize(payload: unknown, timeZone: string): NormalizedAttendanceProviderFact {
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
    return transportRequestId.length >= 8 && dingtalkEnvelopeSchema.safeParse(payload).success;
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
  user_id: z.string().min(1).max(256),
  check_time: z.string().regex(/^\d+$/),
  record_id: z.string().min(1).max(256).optional(),
}).passthrough();
const feishuResponseSchema = z.object({
  code: z.number().int(),
  request_id: z.string().min(8).max(256).optional(),
  data: z.object({
    user_task_results: z.array(z.object({
      result_id: z.string().min(1).max(256),
      user_id: z.string().min(1).max(256),
      records: z.array(z.object({
        check_in_record_id: z.string(),
        check_in_record: feishuRecordSchema.optional(),
        check_out_record_id: z.string(),
        check_out_record: feishuRecordSchema.optional(),
      }).passthrough()).max(32),
    }).passthrough()).max(10_000).optional(),
    invalid_user_ids: z.array(z.string()).max(50).optional(),
    unauthorized_user_ids: z.array(z.string()).max(50).optional(),
  }).passthrough().optional(),
}).passthrough();
const feishuEnvelopeSchema = z.object({
  providerCode: z.literal('feishu'),
  externalEventId: z.string().min(1).max(256),
  direction: z.enum(['in', 'out']),
  pulledAt: z.string().datetime({ offset: true }),
  record: feishuRecordSchema,
}).strict();

/** 飞书打卡结果适配器：只读取自建应用授权范围内员工，未授权员工导致整批失败关闭。 */
@Injectable()
export class FeishuAttendanceProvider extends AttendanceProviderAdapter
  implements AttendanceProviderNormalizer, AttendanceProviderEvidenceVerifier {
  readonly providerCode = 'feishu' as const;
  readonly schemaVersion = 'feishu-user-task-v1';

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
    for (const task of parsed.data.data.user_task_results ?? []) {
      task.records.forEach((slot, slotIndex) => {
        for (const [direction, record, recordId] of [
          ['in', slot.check_in_record, slot.check_in_record_id],
          ['out', slot.check_out_record, slot.check_out_record_id],
        ] as const) {
          if (record === undefined) continue;
          const externalEventId = record.record_id ?? (
            recordId.length > 0 ? recordId : `${task.result_id}:${direction}:${slotIndex}`
          );
          events.push(Object.freeze({
            externalEventId,
            occurredAt: epochSeconds(record.check_time).toISOString(),
            transportRequestId: requestId,
            payload: Object.freeze({
              providerCode: this.providerCode, externalEventId, direction, pulledAt, record,
            }),
          }));
        }
      });
    }
    return Object.freeze(events);
  }

  normalize(payload: unknown, timeZone: string): NormalizedAttendanceProviderFact {
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
    return transportRequestId.length >= 8 && feishuEnvelopeSchema.safeParse(payload).success;
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
  if (input.externalEmployeeIds.length < 1 || input.externalEmployeeIds.length > 50) {
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
    new Date(to).toISOString().slice(0, 10) !== input.toDate ||
    input.externalEmployeeIds.some((id) => id.length < 1 || id.length > 256)
  ) throw new Error('ATTENDANCE_PROVIDER_WINDOW_INVALID');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format();
  } catch {
    throw new Error('ATTENDANCE_PROVIDER_TIME_ZONE_INVALID');
  }
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
  if (value === undefined || !/^[A-Za-z0-9._:-]{8,256}$/.test(value)) {
    throw new Error('ATTENDANCE_PROVIDER_REQUEST_ID_MISSING');
  }
  return value;
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
