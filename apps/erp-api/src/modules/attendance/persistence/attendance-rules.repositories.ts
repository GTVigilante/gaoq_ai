import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AttendanceProviderCoverage,
  AttendanceShiftAssignment,
  AttendanceShiftRule,
} from '../domain/attendance-rules.js';
import {
  AttendanceProviderCoverageRecord,
  type AttendanceProviderCoverageDocument,
  AttendanceShiftAssignmentGuardRecord,
  type AttendanceShiftAssignmentGuardDocument,
  AttendanceShiftAssignmentRecord,
  type AttendanceShiftAssignmentDocument,
  AttendanceShiftRuleRecord,
  type AttendanceShiftRuleDocument,
} from './attendance-rules.schemas.js';

abstract class TenantRepository {
  constructor(protected readonly context: TenantContextService) {}

  protected tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  protected assertTenant(value: string): void {
    if (value !== this.tenantId()) {
      throw new Error('ATTENDANCE_RULE_REPOSITORY_CROSS_TENANT');
    }
  }
}

@Injectable()
export class AttendanceShiftRuleRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceShiftRuleRecord.name)
    private readonly records: Model<AttendanceShiftRuleDocument>,
  ) {
    super(context);
  }

  async findById(
    id: string,
    session?: ClientSession,
  ): Promise<AttendanceShiftRule | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : toRule(record);
  }

  async findForMonth(
    rulesetVersion: string,
    month: string,
    session: ClientSession,
  ): Promise<readonly AttendanceShiftRule[]> {
    const monthEnd = endOfMonth(month);
    const records = await this.records.find({
      tenantId: this.tenantId(),
      rulesetVersion,
      effectiveFrom: { $lte: monthEnd },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: `${month}-01` } }],
    }).sort({ shiftCode: 1, id: 1 }).session(session).lean().exec();
    return Object.freeze(records.map(toRule));
  }

  async insert(rule: AttendanceShiftRule, session: ClientSession): Promise<void> {
    this.assertTenant(rule.tenantId);
    await this.records.create([{
      ...rule,
      workdays: [...rule.workdays],
      createdAt: new Date(rule.createdAt),
      updatedAt: new Date(rule.createdAt),
    }], { session });
  }
}

@Injectable()
export class AttendanceShiftAssignmentRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceShiftAssignmentRecord.name)
    private readonly records: Model<AttendanceShiftAssignmentDocument>,
    @InjectModel(AttendanceShiftAssignmentGuardRecord.name)
    private readonly guards: Model<AttendanceShiftAssignmentGuardDocument>,
  ) {
    super(context);
  }

  /**
   * 必须在读取重叠区间前调用；同一员工的守卫文档使并发事务形成写冲突，
   * 从而避免不同起始日写入产生 MongoDB 快照隔离下的 write skew。
   */
  async serializeEmployee(
    employeeId: string,
    session: ClientSession,
  ): Promise<void> {
    await this.guards.findOneAndUpdate(
      { tenantId: this.tenantId(), employeeId },
      {
        $inc: { revision: 1 },
        $setOnInsert: { tenantId: this.tenantId(), employeeId },
      },
      { upsert: true, session, setDefaultsOnInsert: true },
    ).exec();
  }

  async findOverlapping(
    employeeId: string,
    effectiveFrom: string,
    effectiveTo: string | null,
    session?: ClientSession,
  ): Promise<readonly AttendanceShiftAssignment[]> {
    const query = this.records.find({
      tenantId: this.tenantId(),
      employeeId,
      effectiveFrom: { $lte: effectiveTo ?? '9999-12-31' },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: effectiveFrom } }],
    }).sort({ effectiveFrom: 1, id: 1 });
    if (session !== undefined) query.session(session);
    return Object.freeze((await query.lean().exec()).map(toAssignment));
  }

  async findForMonth(
    employeeId: string,
    month: string,
    session: ClientSession,
  ): Promise<readonly AttendanceShiftAssignment[]> {
    return this.findOverlapping(employeeId, `${month}-01`, endOfMonth(month), session);
  }

  async insert(
    assignment: AttendanceShiftAssignment,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(assignment.tenantId);
    await this.records.create([{
      ...assignment,
      createdAt: new Date(assignment.createdAt),
      updatedAt: new Date(assignment.createdAt),
    }], { session });
  }
}

@Injectable()
export class AttendanceProviderCoverageRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceProviderCoverageRecord.name)
    private readonly records: Model<AttendanceProviderCoverageDocument>,
  ) {
    super(context);
  }

  async findForMonth(
    employeeId: string,
    month: string,
    sourceCutoffAt: Date,
    session: ClientSession,
  ): Promise<readonly AttendanceProviderCoverage[]> {
    const records = await this.records.find({
      tenantId: this.tenantId(),
      employeeId,
      month,
      sourceCutoffAt: { $lte: sourceCutoffAt },
    }).sort({ sourceCutoffAt: -1, id: 1 }).session(session).lean().exec();
    const latest = new Map<string, AttendanceProviderCoverage>();
    for (const record of records) {
      if (!latest.has(record.providerCode)) {
        latest.set(record.providerCode, toCoverage(record));
      }
    }
    return Object.freeze([...latest.values()]);
  }

  async insert(
    coverage: AttendanceProviderCoverage,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(coverage.tenantId);
    await this.records.create([{
      ...coverage,
      sourceCutoffAt: new Date(coverage.sourceCutoffAt),
      createdAt: new Date(coverage.createdAt),
      updatedAt: new Date(coverage.createdAt),
    }], { session });
  }
}

function toRule(record: AttendanceShiftRuleRecord): AttendanceShiftRule {
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    rulesetVersion: record.rulesetVersion,
    shiftCode: record.shiftCode,
    timeZone: record.timeZone,
    startLocalTime: record.startLocalTime,
    endLocalTime: record.endLocalTime,
    workdays: Object.freeze([...record.workdays]),
    plannedMinutes: record.plannedMinutes,
    lateGraceMinutes: record.lateGraceMinutes,
    earlyLeaveGraceMinutes: record.earlyLeaveGraceMinutes,
    crossMidnightPunchOutGraceMinutes: record.crossMidnightPunchOutGraceMinutes,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    governanceEvidenceId: record.governanceEvidenceId,
    evidenceChecksum: record.evidenceChecksum,
    createdAt: record.createdAt.toISOString(),
  });
}

function toAssignment(
  record: AttendanceShiftAssignmentRecord,
): AttendanceShiftAssignment {
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    employeeId: record.employeeId,
    shiftRuleId: record.shiftRuleId,
    providerCode: record.providerCode,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    governanceEvidenceId: record.governanceEvidenceId,
    evidenceChecksum: record.evidenceChecksum,
    createdAt: record.createdAt.toISOString(),
  });
}

function toCoverage(
  record: AttendanceProviderCoverageRecord,
): AttendanceProviderCoverage {
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    employeeId: record.employeeId,
    providerCode: record.providerCode,
    providerStateId: record.providerStateId,
    providerMappingId: record.providerMappingId,
    month: record.month,
    throughBusinessDate: record.throughBusinessDate,
    sourceCutoffAt: record.sourceCutoffAt.toISOString(),
    evidenceChecksum: record.evidenceChecksum,
    createdAt: record.createdAt.toISOString(),
  });
}

function endOfMonth(month: string): string {
  const [yearValue, monthValue] = month.split('-');
  return new Date(Date.UTC(Number(yearValue), Number(monthValue), 0))
    .toISOString()
    .slice(0, 10);
}
