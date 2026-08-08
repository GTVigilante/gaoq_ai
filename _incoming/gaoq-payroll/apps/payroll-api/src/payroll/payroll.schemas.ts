import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID_MAX = 128;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MONEY_MINOR_PATTERN = /^-?(0|[1-9]\d*)$/;

/** 不可变员工薪酬档案密文版本。 */
@Schema({
  collection: 'payroll_compensation_profiles',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class PayrollCompensationProfileRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: BASE64URL_PATTERN })
  employeeBlindIndex!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  version!: number;

  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  effectiveFrom!: string;

  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ })
  effectiveTo!: string | null;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  keyId!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 16, maxlength: 16 })
  iv!: string;

  @Prop({ type: String, required: true, immutable: true, match: BASE64URL_PATTERN })
  ciphertext!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22 })
  authTag!: string;

  @Prop({ type: String, required: true, immutable: true, match: DIGEST_PATTERN })
  plaintextDigest!: string;
}

export type PayrollCompensationProfileDocument =
  HydratedDocument<PayrollCompensationProfileRecord>;
export const PayrollCompensationProfileSchema =
  SchemaFactory.createForClass(PayrollCompensationProfileRecord);
PayrollCompensationProfileSchema.index(
  { tenantId: 1, id: 1 },
  { unique: true },
);
PayrollCompensationProfileSchema.index(
  { tenantId: 1, employeeBlindIndex: 1, version: 1 },
  { unique: true },
);

/** 工资运行控制面，不保存逐员工工资明细。 */
@Schema({
  collection: 'payroll_runs',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class PayrollRunRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ })
  period!: string;

  @Prop({
    type: String,
    enum: [
      'draft', 'calculating', 'calculated', 'pending_approval',
      'locked', 'reconciling', 'reconciled', 'failed',
    ],
    required: true,
  })
  status!: string;

  @Prop({ type: Number, required: true, min: 0 })
  employeeCount!: number;

  @Prop({ type: String, required: true, match: MONEY_MINOR_PATTERN })
  totalGrossMinor!: string;

  @Prop({ type: String, required: true, match: MONEY_MINOR_PATTERN })
  totalNetMinor!: string;

  @Prop({ type: String, default: null, match: DIGEST_PATTERN })
  inputDigest!: string | null;

  @Prop({ type: String, default: null, match: DIGEST_PATTERN })
  resultDigest!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  @Prop({ type: String, default: null, maxlength: ID_MAX })
  submittedBy!: string | null;

  @Prop({ type: String, default: null, maxlength: ID_MAX })
  lockedBy!: string | null;

  @Prop({ type: Date, default: null })
  submittedAt!: Date | null;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;
}

export type PayrollRunDocument = HydratedDocument<PayrollRunRecord>;
export const PayrollRunSchema = SchemaFactory.createForClass(PayrollRunRecord);
PayrollRunSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollRunSchema.index({ tenantId: 1, period: 1, id: 1 }, { unique: true });

/** 单员工工资结果密文；明文工资项和金额不进入控制面。 */
@Schema({
  collection: 'payroll_results',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class PayrollResultRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  payrollRunId!: string;

  @Prop({ type: String, required: true, immutable: true, match: BASE64URL_PATTERN })
  employeeBlindIndex!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  version!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_MAX })
  keyId!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 16, maxlength: 16 })
  iv!: string;

  @Prop({ type: String, required: true, immutable: true, match: BASE64URL_PATTERN })
  ciphertext!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22 })
  authTag!: string;

  @Prop({ type: String, required: true, immutable: true, match: DIGEST_PATTERN })
  plaintextDigest!: string;
}

export type PayrollResultDocument = HydratedDocument<PayrollResultRecord>;
export const PayrollResultSchema = SchemaFactory.createForClass(PayrollResultRecord);
PayrollResultSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PayrollResultSchema.index(
  { tenantId: 1, payrollRunId: 1, employeeBlindIndex: 1 },
  { unique: true },
);
