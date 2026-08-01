import { createHash } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceRuleApplicationService } from '../attendance/application/attendance-rule-application.service.js';
import { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type { ReconcileAttendanceProviderCoverageDto } from './attendance-provider-coverage.dto.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxRecord,
  type AttendanceProviderInboxDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const cursorSchema = z.object({
  throughDate: z.string().regex(DATE_PATTERN),
  windowToDate: z.string().regex(DATE_PATTERN).nullable(),
  employeeAfterId: z.string().regex(ULID_PATTERN).nullable(),
}).strict();

export interface AttendanceProviderCoverageReconcileResult extends Record<string, unknown> {
  readonly stateId: string;
  readonly providerCode: 'dingtalk' | 'feishu';
  readonly month: string;
  readonly throughBusinessDate: string;
  readonly sourceCutoffAt: string;
  readonly attestedCount: number;
  readonly nextAfterMappingId: string | null;
  readonly complete: boolean;
}

@Injectable()
export class AttendanceProviderCoverageService {
  constructor(
    @InjectModel(AttendanceProviderStateRecord.name)
    private readonly states: Model<AttendanceProviderStateDocument>,
    @InjectModel(AttendanceProviderEmployeeMappingRecord.name)
    private readonly mappings: Model<AttendanceProviderEmployeeMappingDocument>,
    @InjectModel(AttendanceProviderInboxRecord.name)
    private readonly inbox: Model<AttendanceProviderInboxDocument>,
    private readonly context: TenantContextService,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly attendanceRules: AttendanceRuleApplicationService,
  ) {}

  async reconcile(
    idempotencyKey: string,
    input: ReconcileAttendanceProviderCoverageDto,
  ): Promise<AttendanceProviderCoverageReconcileResult> {
    this.assertTrustedReconciler();
    const tenantId = this.context.getTenantRequired().tenantId;
    const state = await this.states.findOne({
      tenantId,
      id: input.stateId,
      status: 'active',
    }).lean().exec();
    if (state === null) {
      throw new NotFoundException({
        code: 'ATTENDANCE_PROVIDER_STATE_NOT_FOUND',
        message: '活动考勤 Provider 状态不存在',
      });
    }
    const throughBusinessDate = this.readCompleteThroughDate(state);
    const monthEnd = endOfMonth(input.month);
    if (throughBusinessDate < monthEnd || state.lastPolledAt === null) {
      throw new ConflictException({
        code: 'ATTENDANCE_PROVIDER_WATERMARK_INCOMPLETE',
        message: 'Provider 水位线尚未覆盖完整月份',
      });
    }
    const monthEndExclusive = zonedDateStartUtc(nextMonth(input.month), state.timeZone);
    const unresolvedCount = await this.inbox.countDocuments({
      tenantId,
      stateId: state.id,
      providerCode: state.providerCode,
      providerOccurredAt: { $lt: monthEndExclusive },
      status: { $ne: 'completed' },
    }).exec();
    if (unresolvedCount !== 0) {
      throw new ConflictException({
        code: 'ATTENDANCE_PROVIDER_INBOX_UNRESOLVED',
        message: 'Provider 月份范围内仍有未完成或人工复核 Inbox',
      });
    }
    const limit = input.limit ?? 100;
    const records = await this.mappings.find({
      tenantId,
      providerCode: state.providerCode,
      status: 'active',
      ...(input.afterMappingId === undefined ? {} : { id: { $gt: input.afterMappingId } }),
    }).sort({ id: 1 }).limit(limit + 1).lean().exec();
    if (records.length === 0 && input.afterMappingId === undefined) {
      throw new ConflictException({
        code: 'ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_MISSING',
        message: 'Provider 未配置活动员工映射',
      });
    }
    const page = records.slice(0, limit);
    // 使用已持久化的拉取完成时间，保证相同 Provider 水位重试时证明内容与子幂等键稳定。
    const sourceCutoffAt = state.lastPolledAt.toISOString();
    for (const mapping of page) {
      await this.attendanceRules.attestProviderCoverage(
        childIdempotencyKey(idempotencyKey, {
          tenantId,
          stateId: state.id,
          mappingId: mapping.id,
          month: input.month,
        }),
        {
          employeeId: mapping.employeeId,
          providerCode: state.providerCode,
          providerStateId: state.id,
          providerMappingId: mapping.id,
          month: input.month,
          throughBusinessDate,
          sourceCutoffAt,
        },
      );
    }
    const complete = records.length <= limit;
    return Object.freeze({
      stateId: state.id,
      providerCode: state.providerCode,
      month: input.month,
      throughBusinessDate,
      sourceCutoffAt,
      attestedCount: page.length,
      nextAfterMappingId: complete ? null : page.at(-1)?.id ?? null,
      complete,
    });
  }

  private readCompleteThroughDate(state: AttendanceProviderStateRecord): string {
    if (
      state.cursorKeyId === null ||
      state.cursorIv === null ||
      state.cursorCiphertext === null ||
      state.cursorAuthTag === null
    ) {
      throw new ConflictException({
        code: 'ATTENDANCE_PROVIDER_WATERMARK_MISSING',
        message: 'Provider 尚无完整加密水位线',
      });
    }
    const value = this.crypto.unprotect({
      tenantId: state.tenantId,
      resourceType: 'provider_cursor',
      resourceId: state.id,
    }, {
      keyId: state.cursorKeyId,
      iv: state.cursorIv,
      ciphertext: state.cursorCiphertext,
      authTag: state.cursorAuthTag,
    });
    const parsed = typeof value === 'string' && DATE_PATTERN.test(value)
      ? { throughDate: value, windowToDate: null, employeeAfterId: null }
      : cursorSchema.parse(value);
    if (parsed.windowToDate !== null || parsed.employeeAfterId !== null) {
      throw new ConflictException({
        code: 'ATTENDANCE_PROVIDER_MAPPING_PAGE_INCOMPLETE',
        message: 'Provider 水位线仍处于员工映射分页中',
      });
    }
    return parsed.throughDate;
  }

  private assertTrustedReconciler(): void {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:attendance:provider:reconcile') ||
      !actor.scopes.includes('erp:attendance:coverage:attest')
    ) {
      throw new ForbiddenException({
        code: 'ATTENDANCE_PROVIDER_RECONCILER_REQUIRED',
        message: 'Provider 覆盖对账必须由受信任服务身份执行',
      });
    }
  }
}

function zonedDateStartUtc(date: string, timeZone: string): Date {
  const [
    yearValue = Number.NaN,
    monthValue = Number.NaN,
    dayValue = Number.NaN,
  ] = date.split('-').map(Number);
  const target = Date.UTC(yearValue, monthValue - 1, dayValue, 0, 0, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const delta = target - represented;
    candidate += delta;
    if (delta === 0) return new Date(candidate);
  }
  throw new Error('ATTENDANCE_PROVIDER_TIME_ZONE_BOUNDARY_INVALID');
}

function childIdempotencyKey(
  parent: string,
  value: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([parent, value]))
    .digest('base64url');
}

function endOfMonth(month: string): string {
  const [yearValue, monthValue] = month.split('-');
  return new Date(Date.UTC(Number(yearValue), Number(monthValue), 0))
    .toISOString()
    .slice(0, 10);
}

function nextMonth(month: string): string {
  const [yearValue, monthValue] = month.split('-');
  return new Date(Date.UTC(Number(yearValue), Number(monthValue), 1))
    .toISOString()
    .slice(0, 10);
}
