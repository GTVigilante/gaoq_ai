import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxRecord,
  type AttendanceProviderInboxDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from '../../integration/attendance-provider.schemas.js';
import {
  AttendanceDomainError,
  type AttendanceSourceWatermark,
} from '../domain/index.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 关账只读取 Provider 的非敏感提交水位和 Inbox 处理状态。
 * 外部员工标识、游标密文及原始事件均不离开 Integration 持久化边界。
 */
@Injectable()
export class AttendanceSourceReadinessRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(AttendanceProviderEmployeeMappingRecord.name)
    private readonly mappings: Model<AttendanceProviderEmployeeMappingDocument>,
    @InjectModel(AttendanceProviderStateRecord.name)
    private readonly states: Model<AttendanceProviderStateDocument>,
    @InjectModel(AttendanceProviderInboxRecord.name)
    private readonly inbox: Model<AttendanceProviderInboxDocument>,
  ) {}

  async reconcile(
    employeeId: string,
    month: string,
    cutoffAt: Date,
    session: ClientSession,
    requiredThroughDate = endOfMonth(month),
  ): Promise<readonly AttendanceSourceWatermark[]> {
    if (!MONTH_PATTERN.test(month) || !Number.isFinite(cutoffAt.getTime())) {
      throw new AttendanceDomainError(
        'ATTENDANCE_SOURCE_RECONCILIATION_INVALID',
        '来源水位对账参数非法',
      );
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const mappings = await this.mappings.find({
      tenantId,
      employeeId,
      status: 'active',
    }).sort({ providerCode: 1, id: 1 }).session(session).lean().exec();
    const providers = [...new Set(mappings.map((mapping) => mapping.providerCode))];
    const watermarks: AttendanceSourceWatermark[] = [];
    for (const providerCode of providers) {
      const state = await this.states.findOne({
        tenantId,
        providerCode,
        status: 'active',
      }).session(session).lean().exec();
      if (state === null || state.committedThroughDate === null ||
        state.lastPolledAt === null) {
        throw sourceNotReady(providerCode, 'Provider 未激活或尚无已提交水位');
      }
      if (state.committedThroughDate < requiredThroughDate) {
        throw sourceNotReady(
          providerCode,
          `Provider 仅补拉至 ${state.committedThroughDate}，尚未覆盖 ${requiredThroughDate}`,
        );
      }
      if (state.lastPolledAt.getTime() > cutoffAt.getTime()) {
        throw sourceNotReady(providerCode, 'Provider 水位晚于本次关账截止时间');
      }
      const [rangeStart, rangeEnd] = businessDateRange(
        `${month}-01`,
        shiftDate(requiredThroughDate, 1),
        state.timeZone,
      );
      const blocked = await this.inbox.exists({
        tenantId,
        stateId: state.id,
        providerOccurredAt: { $gte: rangeStart, $lt: rangeEnd },
        createdAt: { $lte: cutoffAt },
        $or: [
          { status: { $ne: 'completed' } },
          { processedAt: { $gt: cutoffAt } },
        ],
      }).session(session);
      if (blocked !== null) {
        throw sourceNotReady(providerCode, 'Provider 当月 Inbox 仍有未完成或晚于截止点的记录');
      }
      const completedInboxCount = await this.inbox.countDocuments({
        tenantId,
        stateId: state.id,
        providerOccurredAt: { $gte: rangeStart, $lt: rangeEnd },
        status: 'completed',
        processedAt: { $lte: cutoffAt },
        createdAt: { $lte: cutoffAt },
      }).session(session);
      watermarks.push(Object.freeze({
        providerCode,
        throughDate: state.committedThroughDate,
        lastPolledAt: state.lastPolledAt.toISOString(),
        completedInboxCount,
      }));
    }
    return Object.freeze(watermarks);
  }
}

function sourceNotReady(providerCode: string, reason: string): AttendanceDomainError {
  return new AttendanceDomainError(
    'ATTENDANCE_SOURCE_NOT_READY',
    `${providerCode} 考勤来源未就绪：${reason}`,
  );
}

function endOfMonth(month: string): string {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

function businessDateRange(
  fromDate: string,
  toDateExclusive: string,
  timeZone: string,
): readonly [Date, Date] {
  const range: readonly [Date, Date] = [
    localDateMidnightToInstant(fromDate, timeZone),
    localDateMidnightToInstant(toDateExclusive, timeZone),
  ];
  return Object.freeze(range);
}

function localDateMidnightToInstant(value: string, timeZone: string): Date {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const target = Date.UTC(year, monthIndex, day);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate += target - represented;
  }
  return new Date(candidate);
}

function shiftDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
