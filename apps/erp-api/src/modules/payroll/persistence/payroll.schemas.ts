import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { PayrollPeriodStatus } from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

abstract class ProtectedPayrollRecord {
  @Prop({ type: String, required: true, maxlength: 64, match: ID_PATTERN }) dataKeyId!: string;
  @Prop({ type: String, required: true, maxlength: 32, match: BASE64URL_PATTERN }) dataIv!: string;
  @Prop({ type: String, required: true, maxlength: 11_184_811, match: BASE64URL_PATTERN })
  dataCiphertext!: string;
  @Prop({ type: String, required: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  dataAuthTag!: string;
}

@Schema({ _id: false, id: false })
class TaxBracketRecord {
  @Prop({ type: Number, default: null, min: 0 }) upperBoundMinor!: number | null;
  @Prop({ type: Number, required: true, min: 0, max: 10_000 }) rateBps!: number;
  @Prop({ type: Number, required: true, min: 0 }) quickDeductionMinor!: number;
}
const TaxBracketRecordSchema = SchemaFactory.createForClass(TaxBracketRecord);

/** 法定规则包为公开规则证据，不含员工 L4 数据。发布后只读。 */
@Schema({ collection: 'payroll_rule_packs', timestamps: true, versionKey: false, id: false })
export class PayrollRulePackRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: ID_PATTERN })
  code!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: ID_PATTERN })
  jurisdictionCode!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN }) effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE_PATTERN })
  effectiveTo!: string | null;
  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  monthlyBasicDeductionMinor!: number;
  @Prop({ type: [TaxBracketRecordSchema], required: true, immutable: true })
  taxBrackets!: TaxBracketRecord[];
  @Prop({ type: String, enum: ['HALF_UP'], required: true, immutable: true })
  roundingMode!: 'HALF_UP';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) rulesHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) sourceDigest!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 }) sourceReference!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string;
  @Prop({ type: String, enum: ['published', 'retired'], required: true })
  status!: 'published' | 'retired';
  @Prop({
    type: String, default: null, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string | null;
  @Prop({ type: String, default: null, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollRulePackDocument = HydratedDocument<PayrollRulePackRecord>;
export const PayrollRulePackRecordSchema = SchemaFactory.createForClass(PayrollRulePackRecord);
PayrollRulePackRecordSchema.pre('validate', function () {
  const record = this as PayrollRulePackRecord;
  if ((record.migrationEvidenceRef === null) !==
    (record.migrationEvidenceChecksum === null)) {
    throw new Error('薪资规则包迁移证据引用与校验和必须成对出现');
  }
});
PayrollRulePackRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollRulePackRecordSchema.index({ tenantId: 1, code: 1, version: 1 }, { unique: true });
PayrollRulePackRecordSchema.index(
  { tenantId: 1, jurisdictionCode: 1, version: 1 }, { unique: true },
);
PayrollRulePackRecordSchema.index(
  { tenantId: 1, jurisdictionCode: 1, effectiveFrom: 1, effectiveTo: 1 },
);
PayrollRulePackRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 },
  { unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } } },
);

/** 员工薪酬结构版本；金额组件与扣款策略全部密文保存。 */
@Schema({ collection: 'payroll_compensation_profiles', timestamps: true, versionKey: false, id: false })
export class PayrollCompensationProfileRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN }) effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE_PATTERN })
  effectiveTo!: string | null;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string;
  @Prop({ type: String, enum: ['active', 'superseded'], required: true })
  status!: 'active' | 'superseded';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) profileHash!: string;
  @Prop({
    type: String, default: null, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string | null;
  @Prop({ type: String, default: null, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCompensationProfileDocument = HydratedDocument<PayrollCompensationProfileRecord>;
export const PayrollCompensationProfileRecordSchema = SchemaFactory.createForClass(
  PayrollCompensationProfileRecord,
);
PayrollCompensationProfileRecordSchema.pre('validate', function () {
  const record = this as PayrollCompensationProfileRecord;
  if ((record.migrationEvidenceRef === null) !==
    (record.migrationEvidenceChecksum === null)) {
    throw new Error('薪酬档案迁移证据引用与校验和必须成对出现');
  }
});
PayrollCompensationProfileRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCompensationProfileRecordSchema.index(
  { tenantId: 1, employeeId: 1, version: 1 }, { unique: true },
);
PayrollCompensationProfileRecordSchema.index(
  { tenantId: 1, employeeId: 1, status: 1, effectiveFrom: 1 },
);
PayrollCompensationProfileRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 },
  { unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } } },
);

const PERIOD_STATUSES: readonly PayrollPeriodStatus[] = [
  'draft', 'collecting', 'review', 'pending_approval', 'approved',
  'locked', 'disbursing', 'reconciling', 'reconciled',
];

@Schema({ collection: 'payroll_periods', timestamps: true, versionKey: false, id: false })
export class PayrollPeriodRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) period!: string;
  @Prop({ type: String, enum: ['CNY'], required: true, immutable: true }) currency!: 'CNY';
  @Prop({ type: String, enum: PERIOD_STATUSES, required: true }) status!: PayrollPeriodStatus;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  preparedBy!: string;
  @Prop({ type: String, default: null, match: ULID_PATTERN }) activeRunId!: string | null;
  @Prop({ type: String, default: null, match: HASH_PATTERN }) inputSnapshotHash!: string | null;
  @Prop({ type: String, default: null, match: HASH_PATTERN }) resultHash!: string | null;
  @Prop({ type: Number, default: null, min: 1 }) employeeCount!: number | null;
  @Prop({ type: Number, default: null, min: 0 }) totalGrossMinor!: number | null;
  @Prop({ type: Number, default: null }) totalTaxMinor!: number | null;
  @Prop({ type: Number, default: null, min: 0 }) totalNetMinor!: number | null;
  @Prop({ type: String, default: null, enum: ['approval_instance', 'legacy_history'] })
  approvalReferenceType!: 'approval_instance' | 'legacy_history' | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  approvalInstanceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) approvedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) lockedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  strongAuthEvidenceId!: string | null;
  @Prop({ type: String, default: null, enum: ['webauthn_evidence', 'migration_lock_evidence'] })
  strongAuthReferenceType!: 'webauthn_evidence' | 'migration_lock_evidence' | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  disbursementBatchId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  disbursementPreparedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  disbursementExportEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  reconciliationEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) reconciledBy!: string | null;
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  @Prop({
    type: String, default: null, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string | null;
  @Prop({ type: String, default: null, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollPeriodDocument = HydratedDocument<PayrollPeriodRecord>;
export const PayrollPeriodRecordSchema = SchemaFactory.createForClass(PayrollPeriodRecord);
PayrollPeriodRecordSchema.pre('validate', function () {
  const record = this as PayrollPeriodRecord;
  if (record.approvalReferenceType === null && record.approvalInstanceId !== null) {
    record.approvalReferenceType = 'approval_instance';
  }
  if (record.strongAuthReferenceType === null && record.strongAuthEvidenceId !== null) {
    record.strongAuthReferenceType = 'webauthn_evidence';
  }
  if ((record.migrationEvidenceRef === null) !==
    (record.migrationEvidenceChecksum === null)) {
    throw new Error('工资周期迁移证据引用与校验和必须成对出现');
  }
  if ((record.approvalReferenceType === null) !== (record.approvalInstanceId === null)) {
    throw new Error('工资周期审批引用类型与标识必须成对出现');
  }
  if ((record.strongAuthReferenceType === null) !== (record.strongAuthEvidenceId === null)) {
    throw new Error('工资周期强认证引用类型与标识必须成对出现');
  }
});
PayrollPeriodRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollPeriodRecordSchema.index({ tenantId: 1, period: 1 }, { unique: true });
PayrollPeriodRecordSchema.index({ tenantId: 1, status: 1, period: 1 });
PayrollPeriodRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 },
  { unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } } },
);

@Schema({ collection: 'payroll_calculation_runs', timestamps: true, versionKey: false, id: false })
export class PayrollCalculationRunRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) period!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) runNumber!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  engineVersion!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) rulePackId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) rulePackVersion!: number;
  @Prop({ type: String, enum: ['completed', 'failed'], required: true })
  status!: 'completed' | 'failed';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  inputSnapshotHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) resultHash!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) employeeCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) totalGrossMinor!: number;
  @Prop({ type: Number, required: true, immutable: true }) totalTaxMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) totalNetMinor!: number;
  @Prop({ type: Date, required: true, immutable: true }) completedAt!: Date;
  @Prop({
    type: String, default: null, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string | null;
  @Prop({ type: String, default: null, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCalculationRunDocument = HydratedDocument<PayrollCalculationRunRecord>;
export const PayrollCalculationRunRecordSchema = SchemaFactory.createForClass(
  PayrollCalculationRunRecord,
);
PayrollCalculationRunRecordSchema.pre('validate', function () {
  const record = this as PayrollCalculationRunRecord;
  if ((record.migrationEvidenceRef === null) !==
    (record.migrationEvidenceChecksum === null)) {
    throw new Error('工资计算运行迁移证据引用与校验和必须成对出现');
  }
});
PayrollCalculationRunRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCalculationRunRecordSchema.index({ tenantId: 1, periodId: 1, runNumber: 1 }, { unique: true });
PayrollCalculationRunRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 },
  { unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } } },
);

/** 历史工资审批控制证据；不把旧审批历史伪装成在线审批实例。 */
@Schema({ collection: 'payroll_period_approval_evidence', timestamps: true, versionKey: false, id: false })
export class PayrollPeriodApprovalEvidenceRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  approvalHistoryId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  approvalEvidenceChecksum!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvedBy!: string;
  @Prop({ type: Date, required: true, immutable: true }) approvedAt!: Date;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) periodVersion!: number;
  @Prop({
    type: String, required: true, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollPeriodApprovalEvidenceDocument =
  HydratedDocument<PayrollPeriodApprovalEvidenceRecord>;
export const PayrollPeriodApprovalEvidenceRecordSchema = SchemaFactory.createForClass(
  PayrollPeriodApprovalEvidenceRecord,
);
PayrollPeriodApprovalEvidenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollPeriodApprovalEvidenceRecordSchema.index({ tenantId: 1, periodId: 1 }, { unique: true });
PayrollPeriodApprovalEvidenceRecordSchema.index(
  { tenantId: 1, approvalHistoryId: 1 }, { unique: true },
);
PayrollPeriodApprovalEvidenceRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 }, { unique: true },
);

/** 历史工资锁定证据；强认证正文只在 WORM，在线仅保存不可变控制字段。 */
@Schema({ collection: 'payroll_period_lock_evidence', timestamps: true, versionKey: false, id: false })
export class PayrollPeriodLockEvidenceRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  approvalControlEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  lockedBy!: string;
  @Prop({ type: Date, required: true, immutable: true }) lockedAt!: Date;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) periodVersion!: number;
  @Prop({ type: String, required: true, immutable: true, enum: ['webauthn_uv'] })
  strongAuthMethod!: 'webauthn_uv';
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) operationId!: string;
  @Prop({
    type: String, required: true, immutable: true, maxlength: 256,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  migrationEvidenceChecksum!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollPeriodLockEvidenceDocument = HydratedDocument<PayrollPeriodLockEvidenceRecord>;
export const PayrollPeriodLockEvidenceRecordSchema = SchemaFactory.createForClass(
  PayrollPeriodLockEvidenceRecord,
);
PayrollPeriodLockEvidenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollPeriodLockEvidenceRecordSchema.index({ tenantId: 1, periodId: 1 }, { unique: true });
PayrollPeriodLockEvidenceRecordSchema.index(
  { tenantId: 1, approvalControlEvidenceId: 1 }, { unique: true },
);
PayrollPeriodLockEvidenceRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 }, { unique: true },
);

@Schema({ collection: 'payroll_input_snapshots', timestamps: true, versionKey: false, id: false })
export class PayrollInputSnapshotRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) runId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  compensationProfileId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  attendanceSnapshotId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  attendanceSnapshotHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) inputHash!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollInputSnapshotDocument = HydratedDocument<PayrollInputSnapshotRecord>;
export const PayrollInputSnapshotRecordSchema = SchemaFactory.createForClass(PayrollInputSnapshotRecord);
PayrollInputSnapshotRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollInputSnapshotRecordSchema.index({ tenantId: 1, runId: 1, employeeId: 1 }, { unique: true });

@Schema({ collection: 'payroll_calculation_lines', timestamps: true, versionKey: false, id: false })
export class PayrollCalculationLineRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) runId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) resultHash!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCalculationLineDocument = HydratedDocument<PayrollCalculationLineRecord>;
export const PayrollCalculationLineRecordSchema = SchemaFactory.createForClass(
  PayrollCalculationLineRecord,
);
PayrollCalculationLineRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCalculationLineRecordSchema.index({ tenantId: 1, runId: 1, employeeId: 1 }, { unique: true });

/** 个税内部清单及税局回执控制记录；员工税务行只存在于 Payroll 密文和 WORM。 */
@Schema({ collection: 'payroll_tax_filings', timestamps: true, versionKey: false, id: false })
export class PayrollTaxFilingRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) payrollRunId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  payrollResultHash!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['CN_IIT_WITHHOLDING_MANIFEST_V1'] })
  format!: 'CN_IIT_WITHHOLDING_MANIFEST_V1';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) contentHash!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 })
  employeeCount!: number;
  @Prop({
    type: Number, required: true, immutable: true,
    min: 0, max: Number.MAX_SAFE_INTEGER,
  })
  totalTaxableEarningsMinor!: number;
  @Prop({
    type: Number, required: true, immutable: true,
    min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER,
  })
  totalWithholdingTaxMinor!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  preparedBy!: string;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) approvedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  strongAuthEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 512, match: /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/ })
  objectRef!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  objectEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  taxSubmissionId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  taxSubmissionEvidenceId!: string | null;
  @Prop({
    type: String, required: true,
    enum: ['archiving', 'prepared', 'approved', 'submitting', 'submitted', 'rejected'],
  })
  status!: 'archiving' | 'prepared' | 'approved' | 'submitting' | 'submitted' | 'rejected';
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollTaxFilingDocument = HydratedDocument<PayrollTaxFilingRecord>;
export const PayrollTaxFilingRecordSchema = SchemaFactory.createForClass(PayrollTaxFilingRecord);
PayrollTaxFilingRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollTaxFilingRecordSchema.index({ tenantId: 1, periodId: 1 }, { unique: true });
PayrollTaxFilingRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
PayrollTaxFilingRecordSchema.index(
  { tenantId: 1, taxSubmissionId: 1 },
  { unique: true, partialFilterExpression: { taxSubmissionId: { $type: 'string' } } },
);

const RECONCILIATION_DIFFERENCE_CODES = [
  'PAYROLL_BANK_AMOUNT_MISMATCH',
  'BANK_RETURN_AMOUNT_MISMATCH',
  'BANK_RETURN_COUNT_MISMATCH',
  'PAYROLL_TAX_AMOUNT_MISMATCH',
  'PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH',
] as const;

/** 四方对账不可变控制快照；只保存聚合、摘要和外部证据引用。 */
@Schema({ collection: 'payroll_reconciliations', timestamps: true, versionKey: false, id: false })
export class PayrollReconciliationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) payrollRunId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  payrollResultHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) batchId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) bankReturnId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) returnHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  bankSubmissionId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  disbursementObjectEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  bankSubmissionEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  bankReturnObjectEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  signatureEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  malwareScanEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) taxFilingId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  taxSubmissionId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  taxSubmissionEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) taxContentHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  settlementChainHash!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 })
  employeeCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 })
  bankLineCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  totalGrossMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  totalNetMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  bankSubmittedMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  bankReturnedMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  totalTaxableEarningsMinor!: number;
  @Prop({
    type: Number, required: true, immutable: true,
    min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER,
  })
  payrollWithholdingTaxMinor!: number;
  @Prop({
    type: Number, required: true, immutable: true,
    min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER,
  })
  filedWithholdingTaxMinor!: number;
  @Prop({ type: [String], required: true, immutable: true, enum: RECONCILIATION_DIFFERENCE_CODES })
  differences!: string[];
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) evidenceHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  reconciledBy!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['balanced', 'frozen'] })
  status!: 'balanced' | 'frozen';
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollReconciliationDocument = HydratedDocument<PayrollReconciliationRecord>;
export const PayrollReconciliationRecordSchema = SchemaFactory.createForClass(
  PayrollReconciliationRecord,
);
PayrollReconciliationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollReconciliationRecordSchema.index({ tenantId: 1, periodId: 1 }, { unique: true });
PayrollReconciliationRecordSchema.index({ tenantId: 1, payrollRunId: 1 }, { unique: true });
PayrollReconciliationRecordSchema.index({ tenantId: 1, batchId: 1 }, { unique: true });
PayrollReconciliationRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });

const SHADOW_DIFFERENCE_CODES = [
  'LEGACY_EMPLOYEE_MISSING',
  'ERP_EMPLOYEE_MISSING',
  'GROSS_AMOUNT_MISMATCH',
  'WITHHOLDING_TAX_MISMATCH',
  'NET_AMOUNT_MISMATCH',
] as const;

/** 单个薪资影子周期的不可变控制证据；旧系统行清单只保存在本记录密文与独立 WORM。 */
@Schema({ collection: 'payroll_shadow_cycles', timestamps: true, versionKey: false, id: false })
export class PayrollShadowCycleRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) periodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) payrollRunId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) period!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  sourceSystem!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  sourceExportId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  sourceObjectEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  sourceSignatureEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  sourceManifestHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  payrollResultHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  comparisonHash!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 })
  erpEmployeeCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 })
  legacyEmployeeCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  erpTotalGrossMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  legacyTotalGrossMinor!: number;
  @Prop({ type: Number, required: true, immutable: true }) erpTotalTaxMinor!: number;
  @Prop({ type: Number, required: true, immutable: true }) legacyTotalTaxMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  erpTotalNetMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  legacyTotalNetMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 15_000 })
  differenceCount!: number;
  @Prop({ type: [String], required: true, immutable: true, enum: SHADOW_DIFFERENCE_CODES })
  differenceCodes!: string[];
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  totalAbsoluteDifferenceMinor!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  importedBy!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollShadowCycleDocument = HydratedDocument<PayrollShadowCycleRecord>;
export const PayrollShadowCycleRecordSchema = SchemaFactory.createForClass(PayrollShadowCycleRecord);
PayrollShadowCycleRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollShadowCycleRecordSchema.index({ tenantId: 1, periodId: 1 }, { unique: true });
PayrollShadowCycleRecordSchema.index({ tenantId: 1, payrollRunId: 1 }, { unique: true });
PayrollShadowCycleRecordSchema.index({ tenantId: 1, sourceSystem: 1, sourceExportId: 1 }, { unique: true });
PayrollShadowCycleRecordSchema.index({ tenantId: 1, period: 1 });

/** 行级差异为不可变 L4 密文；明文只保留标准码与完整性摘要。 */
@Schema({ collection: 'payroll_shadow_differences', timestamps: true, versionKey: false, id: false })
export class PayrollShadowDifferenceRecord extends ProtectedPayrollRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) cycleId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: SHADOW_DIFFERENCE_CODES })
  code!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  evidenceHash!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollShadowDifferenceDocument = HydratedDocument<PayrollShadowDifferenceRecord>;
export const PayrollShadowDifferenceRecordSchema = SchemaFactory.createForClass(
  PayrollShadowDifferenceRecord,
);
PayrollShadowDifferenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollShadowDifferenceRecordSchema.index({ tenantId: 1, cycleId: 1, evidenceHash: 1 }, { unique: true });
PayrollShadowDifferenceRecordSchema.index({ tenantId: 1, cycleId: 1, code: 1 });

const SHADOW_EXPLANATION_CODES = [
  'LEGACY_RULE_VERSION', 'LEGACY_INPUT_CUTOFF', 'LEGACY_ROUNDING',
  'LEGACY_MASTER_DATA', 'APPROVED_MANUAL_ADJUSTMENT', 'OTHER_VERIFIED',
] as const;

/** 差异解释采用追加式证据，一条差异只能形成一次最终归因。 */
@Schema({ collection: 'payroll_shadow_explanations', timestamps: true, versionKey: false, id: false })
export class PayrollShadowExplanationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) cycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) differenceId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: SHADOW_EXPLANATION_CODES })
  explanationCode!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  evidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  explainedBy!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) evidenceHash!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollShadowExplanationDocument = HydratedDocument<PayrollShadowExplanationRecord>;
export const PayrollShadowExplanationRecordSchema = SchemaFactory.createForClass(
  PayrollShadowExplanationRecord,
);
PayrollShadowExplanationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollShadowExplanationRecordSchema.index({ tenantId: 1, differenceId: 1 }, { unique: true });
PayrollShadowExplanationRecordSchema.index({ tenantId: 1, cycleId: 1, createdAt: 1 });

/** 财务 WebAuthn 签署为不可变记录，与导入、工资制单、审批、锁定及归因人员隔离。 */
@Schema({ collection: 'payroll_shadow_signoffs', timestamps: true, versionKey: false, id: false })
export class PayrollShadowSignoffRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) cycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) period!: string;
  @Prop({
    type: String, required: true, immutable: true, enum: ['payroll_owner', 'finance_owner'],
  })
  role!: 'payroll_owner' | 'finance_owner';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  comparisonHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  explanationSetHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  signedBy!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  strongAuthEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) evidenceHash!: string;
  @Prop({ type: Date, required: true, immutable: true }) signedAt!: Date;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollShadowSignoffDocument = HydratedDocument<PayrollShadowSignoffRecord>;
export const PayrollShadowSignoffRecordSchema = SchemaFactory.createForClass(
  PayrollShadowSignoffRecord,
);
PayrollShadowSignoffRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollShadowSignoffRecordSchema.index({ tenantId: 1, cycleId: 1, role: 1 }, { unique: true });
PayrollShadowSignoffRecordSchema.index({ tenantId: 1, period: 1, role: 1 }, { unique: true });

/** 连续两个完整周期通过后的可切换证据；仅表达资格，不执行事实源切换。 */
@Schema({ collection: 'payroll_cutover_readiness', timestamps: true, versionKey: false, id: false })
export class PayrollCutoverReadinessRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) firstCycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) secondCycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) startPeriod!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) endPeriod!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) evidenceHash!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['eligible'] }) status!: 'eligible';
  @Prop({ type: Date, required: true, immutable: true }) generatedAt!: Date;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCutoverReadinessDocument = HydratedDocument<PayrollCutoverReadinessRecord>;
export const PayrollCutoverReadinessRecordSchema = SchemaFactory.createForClass(
  PayrollCutoverReadinessRecord,
);
PayrollCutoverReadinessRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCutoverReadinessRecordSchema.index({ tenantId: 1, secondCycleId: 1 }, { unique: true });
PayrollCutoverReadinessRecordSchema.index({ tenantId: 1, endPeriod: 1 }, { unique: true });
