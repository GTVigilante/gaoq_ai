import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { PayrollPeriodStatus } from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollRulePackDocument = HydratedDocument<PayrollRulePackRecord>;
export const PayrollRulePackRecordSchema = SchemaFactory.createForClass(PayrollRulePackRecord);
PayrollRulePackRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollRulePackRecordSchema.index({ tenantId: 1, code: 1, version: 1 }, { unique: true });
PayrollRulePackRecordSchema.index(
  { tenantId: 1, jurisdictionCode: 1, version: 1 }, { unique: true },
);
PayrollRulePackRecordSchema.index(
  { tenantId: 1, jurisdictionCode: 1, effectiveFrom: 1, effectiveTo: 1 },
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
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCompensationProfileDocument = HydratedDocument<PayrollCompensationProfileRecord>;
export const PayrollCompensationProfileRecordSchema = SchemaFactory.createForClass(
  PayrollCompensationProfileRecord,
);
PayrollCompensationProfileRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCompensationProfileRecordSchema.index(
  { tenantId: 1, employeeId: 1, version: 1 }, { unique: true },
);
PayrollCompensationProfileRecordSchema.index(
  { tenantId: 1, employeeId: 1, status: 1, effectiveFrom: 1 },
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
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  approvalInstanceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) approvedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN }) lockedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  strongAuthEvidenceId!: string | null;
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
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollPeriodDocument = HydratedDocument<PayrollPeriodRecord>;
export const PayrollPeriodRecordSchema = SchemaFactory.createForClass(PayrollPeriodRecord);
PayrollPeriodRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollPeriodRecordSchema.index({ tenantId: 1, period: 1 }, { unique: true });
PayrollPeriodRecordSchema.index({ tenantId: 1, status: 1, period: 1 });

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
  createdAt!: Date;
  updatedAt!: Date;
}
export type PayrollCalculationRunDocument = HydratedDocument<PayrollCalculationRunRecord>;
export const PayrollCalculationRunRecordSchema = SchemaFactory.createForClass(
  PayrollCalculationRunRecord,
);
PayrollCalculationRunRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollCalculationRunRecordSchema.index({ tenantId: 1, periodId: 1, runNumber: 1 }, { unique: true });

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
