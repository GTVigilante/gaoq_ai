import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AttendanceCorrection,
  AttendanceMonthlySnapshot,
  AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceDataCryptoService, type ProtectedAttendanceData } from './attendance-data-crypto.service.js';
import {
  AttendanceCorrectionRecord,
  type AttendanceCorrectionDocument,
  AttendanceMonthlySnapshotRecord,
  type AttendanceMonthlySnapshotDocument,
  AttendanceSourceFactRecord,
  type AttendanceSourceFactDocument,
} from './attendance.schemas.js';

const impactSchema = z.object({
  workedMinutes: z.number().int().nonnegative(),
  leaveMinutes: z.number().int().nonnegative(),
  overtimeMinutes: z.number().int().nonnegative(),
  absentMinutes: z.number().int().nonnegative(),
}).strict();
const factPayloadSchema = z.object({
  occurredAt: z.string(), timeZone: z.string(), impact: impactSchema,
}).strict();
const correctionPayloadSchema = z.object({
  replacementImpact: impactSchema,
  reasonCode: z.string(),
}).strict();
const dailySummarySchema = impactSchema.extend({
  businessDate: z.string(), sourceFactCount: z.number().int().nonnegative(),
  correctionCount: z.number().int().nonnegative(), digest: z.string(),
}).strict();
const snapshotPayloadSchema = z.object({ dailySummaries: z.array(dailySummarySchema) }).strict();

abstract class TenantRepository {
  constructor(protected readonly context: TenantContextService) {}
  protected tenantId(): string { return this.context.getTenantRequired().tenantId; }
  protected assertTenant(value: string): void {
    if (value !== this.tenantId()) throw new Error('Attendance 仓储拒绝跨租户实体');
  }
}

@Injectable()
export class AttendanceSourceFactRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceSourceFactRecord.name)
    private readonly records: Model<AttendanceSourceFactDocument>,
    private readonly crypto: AttendanceDataCryptoService,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<AttendanceSourceFact | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findByEventFingerprints(
    fingerprints: readonly string[],
    session?: ClientSession,
  ): Promise<AttendanceSourceFact | null> {
    const query = this.records.findOne({
      tenantId: this.tenantId(), sourceEventBlindIndexes: { $in: [...fingerprints] },
    });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findForMonth(
    employeeId: string,
    month: string,
    cutoffAt: Date,
    session: ClientSession,
  ): Promise<readonly AttendanceSourceFact[]> {
    const records = await this.records.find({
      tenantId: this.tenantId(), employeeId,
      businessDate: { $gte: `${month}-01`, $lte: `${month}-31` },
      sourceObservedAt: { $lte: cutoffAt },
      createdAt: { $lte: cutoffAt },
    }).sort({ businessDate: 1, id: 1 }).session(session).lean().exec();
    return Object.freeze(records.map((record) => this.toDomain(record)));
  }

  async insert(
    fact: AttendanceSourceFact,
    sourceEventBlindIndexes: readonly string[],
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(fact.tenantId);
    const protectedData = this.crypto.protect(
      { tenantId: fact.tenantId, resourceType: 'source_fact', resourceId: fact.id },
      { occurredAt: fact.occurredAt, timeZone: fact.timeZone, impact: fact.impact },
    );
    await this.records.create([{
      id: fact.id, tenantId: fact.tenantId, employeeId: fact.employeeId,
      providerCode: fact.providerCode, factType: fact.factType, businessDate: fact.businessDate,
      sourceObservedAt: new Date(fact.sourceObservedAt), sourceEventBlindIndexes: [...sourceEventBlindIndexes],
      ...toProtectedRecord(protectedData), createdAt: new Date(fact.createdAt), updatedAt: new Date(fact.createdAt),
    }], { session });
  }

  private toDomain(record: AttendanceSourceFactRecord): AttendanceSourceFact {
    const payload = factPayloadSchema.parse(this.crypto.unprotect(
      { tenantId: record.tenantId, resourceType: 'source_fact', resourceId: record.id },
      fromProtectedRecord(record),
    ));
    return Object.freeze({
      id: record.id, tenantId: record.tenantId, employeeId: record.employeeId,
      providerCode: record.providerCode, factType: record.factType,
      occurredAt: payload.occurredAt, timeZone: payload.timeZone,
      businessDate: record.businessDate, impact: Object.freeze(payload.impact),
      sourceObservedAt: record.sourceObservedAt.toISOString(), createdAt: record.createdAt.toISOString(),
    });
  }
}

@Injectable()
export class AttendanceCorrectionRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceCorrectionRecord.name)
    private readonly records: Model<AttendanceCorrectionDocument>,
    private readonly crypto: AttendanceDataCryptoService,
  ) { super(context); }

  async findBySourceFactId(sourceFactId: string): Promise<AttendanceCorrection | null> {
    const record = await this.records.findOne({
      tenantId: this.tenantId(), sourceFactId,
    }).lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findForMonth(
    employeeId: string,
    month: string,
    cutoffAt: Date,
    session: ClientSession,
  ): Promise<readonly AttendanceCorrection[]> {
    const records = await this.records.find({
      tenantId: this.tenantId(), employeeId,
      businessDate: { $gte: `${month}-01`, $lte: `${month}-31` },
      approvedAt: { $lte: cutoffAt },
      createdAt: { $lte: cutoffAt },
    }).sort({ businessDate: 1, id: 1 }).session(session).lean().exec();
    return Object.freeze(records.map((record) => this.toDomain(record)));
  }

  async insert(correction: AttendanceCorrection, session: ClientSession): Promise<void> {
    this.assertTenant(correction.tenantId);
    const protectedData = this.crypto.protect(
      { tenantId: correction.tenantId, resourceType: 'correction', resourceId: correction.id },
      { replacementImpact: correction.replacementImpact, reasonCode: correction.reasonCode },
    );
    await this.records.create([{
      id: correction.id, tenantId: correction.tenantId, employeeId: correction.employeeId,
      sourceFactId: correction.sourceFactId, businessDate: correction.businessDate,
      approvalInstanceId: correction.approvalInstanceId,
      approvalEvidenceId: correction.approvalEvidenceId,
      approvedAt: new Date(correction.approvedAt), ...toProtectedRecord(protectedData),
      createdAt: new Date(correction.createdAt), updatedAt: new Date(correction.createdAt),
    }], { session });
  }

  private toDomain(record: AttendanceCorrectionRecord): AttendanceCorrection {
    const payload = correctionPayloadSchema.parse(this.crypto.unprotect(
      { tenantId: record.tenantId, resourceType: 'correction', resourceId: record.id },
      fromProtectedRecord(record),
    ));
    return Object.freeze({
      id: record.id, tenantId: record.tenantId, employeeId: record.employeeId,
      sourceFactId: record.sourceFactId, businessDate: record.businessDate,
      replacementImpact: Object.freeze(payload.replacementImpact), reasonCode: payload.reasonCode,
      approvalInstanceId: record.approvalInstanceId, approvalEvidenceId: record.approvalEvidenceId,
      approvedAt: record.approvedAt.toISOString(), createdAt: record.createdAt.toISOString(),
    });
  }
}

@Injectable()
export class AttendanceMonthlySnapshotRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(AttendanceMonthlySnapshotRecord.name)
    private readonly records: Model<AttendanceMonthlySnapshotDocument>,
    private readonly crypto: AttendanceDataCryptoService,
  ) { super(context); }

  async findActive(
    employeeId: string,
    month: string,
    session?: ClientSession,
  ): Promise<AttendanceMonthlySnapshot | null> {
    const query = this.records.findOne({
      tenantId: this.tenantId(), employeeId, month, status: 'active',
    });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async activate(
    snapshot: AttendanceMonthlySnapshot,
    previous: AttendanceMonthlySnapshot | null,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(snapshot.tenantId);
    if (previous !== null) {
      this.assertTenant(previous.tenantId);
      const result = await this.records.updateOne(
        { tenantId: this.tenantId(), id: previous.id, status: 'active' },
        { $set: { status: 'superseded' } },
        { session, timestamps: false },
      );
      if (result.matchedCount !== 1) throw new Error('ATTENDANCE_SNAPSHOT_WRITE_CONFLICT');
    }
    const protectedData = this.crypto.protect(
      { tenantId: snapshot.tenantId, resourceType: 'monthly_snapshot', resourceId: snapshot.id },
      { dailySummaries: snapshot.dailySummaries },
    );
    await this.records.create([{
      id: snapshot.id, tenantId: snapshot.tenantId, employeeId: snapshot.employeeId,
      month: snapshot.month, snapshotVersion: snapshot.snapshotVersion,
      rulesetVersion: snapshot.rulesetVersion,
      sourceCutoffAt: new Date(snapshot.sourceCutoffAt), closedAt: new Date(snapshot.closedAt),
      workedMinutes: snapshot.workedMinutes, leaveMinutes: snapshot.leaveMinutes,
      overtimeMinutes: snapshot.overtimeMinutes, absentMinutes: snapshot.absentMinutes,
      sourceFactCount: snapshot.sourceFactCount, correctionCount: snapshot.correctionCount,
      snapshotHash: snapshot.snapshotHash, status: snapshot.status,
      previousSnapshotId: snapshot.previousSnapshotId,
      supersessionEvidenceId: snapshot.supersessionEvidenceId,
      ...toProtectedRecord(protectedData),
    }], { session });
  }

  private toDomain(record: AttendanceMonthlySnapshotRecord): AttendanceMonthlySnapshot {
    const payload = snapshotPayloadSchema.parse(this.crypto.unprotect(
      { tenantId: record.tenantId, resourceType: 'monthly_snapshot', resourceId: record.id },
      fromProtectedRecord(record),
    ));
    return Object.freeze({
      id: record.id, tenantId: record.tenantId, employeeId: record.employeeId,
      month: record.month, snapshotVersion: record.snapshotVersion,
      rulesetVersion: record.rulesetVersion, sourceCutoffAt: record.sourceCutoffAt.toISOString(),
      workedMinutes: record.workedMinutes, leaveMinutes: record.leaveMinutes,
      overtimeMinutes: record.overtimeMinutes, absentMinutes: record.absentMinutes,
      sourceFactCount: record.sourceFactCount, correctionCount: record.correctionCount,
      dailySummaries: Object.freeze(payload.dailySummaries.map((day) => Object.freeze(day))),
      snapshotHash: record.snapshotHash, status: record.status,
      previousSnapshotId: record.previousSnapshotId,
      supersessionEvidenceId: record.supersessionEvidenceId,
      closedAt: record.closedAt.toISOString(),
    });
  }
}

function toProtectedRecord(value: ProtectedAttendanceData): Record<string, string> {
  return {
    dataKeyId: value.keyId,
    dataIv: value.iv,
    dataCiphertext: value.ciphertext,
    dataAuthTag: value.authTag,
  };
}

function fromProtectedRecord(value: ProtectedRecordShape): ProtectedAttendanceData {
  return {
    keyId: value.dataKeyId,
    iv: value.dataIv,
    ciphertext: value.dataCiphertext,
    authTag: value.dataAuthTag,
  };
}

interface ProtectedRecordShape {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}
