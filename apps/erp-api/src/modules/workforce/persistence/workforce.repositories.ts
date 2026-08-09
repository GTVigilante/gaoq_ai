import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { HrbpAssignment, ReportingLine } from '../domain/workforce.js';
import {
  HrbpAssignmentRecord,
  type HrbpAssignmentDocument,
  ReportingLineRecord,
  type ReportingLineDocument,
} from './workforce.schemas.js';

@Injectable()
export class ReportingLineRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(ReportingLineRecord.name) private readonly records: Model<ReportingLineDocument>,
  ) {}

  async findEffective(employeeId: string, asOf: string, session?: ClientSession): Promise<ReportingLine | null> {
    const query = this.records.findOne({
      tenantId: this.context.getTenantRequired().tenantId,
      employeeId,
      effectiveFrom: { $lte: asOf },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
    }).sort({ effectiveFrom: -1, id: 1 });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : toReportingLine(record);
  }

  async overlaps(employeeId: string, from: string, to: string | null, session: ClientSession): Promise<boolean> {
    return (await this.records.exists({
      tenantId: this.context.getTenantRequired().tenantId,
      employeeId,
      effectiveFrom: { $lte: to ?? '9999-12-31' },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
    }).session(session)) !== null;
  }

  async insert(value: ReportingLine, session: ClientSession): Promise<void> {
    await this.records.create([{ ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }], { session });
  }

  async list(asOf: string): Promise<readonly ReportingLine[]> {
    const records = await this.records.find({
      tenantId: this.context.getTenantRequired().tenantId,
      effectiveFrom: { $lte: asOf },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
    }).sort({ employeeId: 1, effectiveFrom: -1 }).limit(1001).lean().exec();
    if (records.length > 1000) throw new Error('WORKFORCE_REPORTING_LIST_LIMIT');
    return Object.freeze(records.map(toReportingLine));
  }
}

@Injectable()
export class HrbpAssignmentRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(HrbpAssignmentRecord.name) private readonly records: Model<HrbpAssignmentDocument>,
  ) {}

  async overlaps(departmentId: string, from: string, to: string | null, session: ClientSession): Promise<boolean> {
    return (await this.records.exists({
      tenantId: this.context.getTenantRequired().tenantId,
      departmentId,
      effectiveFrom: { $lte: to ?? '9999-12-31' },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
    }).session(session)) !== null;
  }

  async findEffective(departmentId: string, asOf: string, session?: ClientSession): Promise<HrbpAssignment | null> {
    const query = this.records.findOne({
      tenantId: this.context.getTenantRequired().tenantId,
      departmentId,
      effectiveFrom: { $lte: asOf },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
    }).sort({ effectiveFrom: -1, id: 1 });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : toHrbpAssignment(record);
  }

  async insert(value: HrbpAssignment, session: ClientSession): Promise<void> {
    await this.records.create([{
      ...value,
      backupEmployeeIds: [...value.backupEmployeeIds],
      createdAt: new Date(value.createdAt),
      updatedAt: new Date(value.updatedAt),
    }], { session });
  }

  async list(asOf: string): Promise<readonly HrbpAssignment[]> {
    const records = await this.records.find({
      tenantId: this.context.getTenantRequired().tenantId,
      effectiveFrom: { $lte: asOf },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
    }).sort({ departmentId: 1, effectiveFrom: -1 }).limit(1001).lean().exec();
    if (records.length > 1000) throw new Error('WORKFORCE_HRBP_LIST_LIMIT');
    return Object.freeze(records.map(toHrbpAssignment));
  }
}

function toReportingLine(record: ReportingLineRecord): ReportingLine {
  return Object.freeze({
    id: record.id, tenantId: record.tenantId, employeeId: record.employeeId,
    managerEmployeeId: record.managerEmployeeId, effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo, version: record.version,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  });
}

function toHrbpAssignment(record: HrbpAssignmentRecord): HrbpAssignment {
  return Object.freeze({
    id: record.id, tenantId: record.tenantId, departmentId: record.departmentId,
    primaryEmployeeId: record.primaryEmployeeId,
    backupEmployeeIds: Object.freeze([...record.backupEmployeeIds]),
    inheritToDescendants: record.inheritToDescendants,
    effectiveFrom: record.effectiveFrom, effectiveTo: record.effectiveTo, version: record.version,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  });
}
