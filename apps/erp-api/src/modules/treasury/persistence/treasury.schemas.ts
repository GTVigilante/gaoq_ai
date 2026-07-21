import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { DisbursementBatchStatus } from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BLIND_INDEX_PATTERN = /^[A-Za-z0-9._-]{1,64}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT_LENGTH = 11_184_811;

abstract class ProtectedTreasuryRecord {
  @Prop({ type: String, required: true, maxlength: 64, match: ID_PATTERN }) dataKeyId!: string;
  @Prop({ type: String, required: true, maxlength: 32, match: BASE64URL_PATTERN }) dataIv!: string;
  @Prop({ type: String, required: true, maxlength: MAX_CIPHERTEXT_LENGTH, match: BASE64URL_PATTERN })
  dataCiphertext!: string;
  @Prop({ type: String, required: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  dataAuthTag!: string;
}

/** 收付款账户档案；户名、账号和清算行号只存在于密文，盲索引仅支持精确防重。 */
@Schema({ collection: 'treasury_bank_accounts', timestamps: true, versionKey: false, id: false })
export class TreasuryBankAccountRecord extends ProtectedTreasuryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['organization', 'employee'] })
  ownerType!: 'organization' | 'employee';
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  ownerId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) version!: number;
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true, immutable: true })
  accountBlindIndexes!: string[];
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) dataHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string;
  @Prop({ type: String, required: true, enum: ['active', 'revoked'] })
  status!: 'active' | 'revoked';
  createdAt!: Date;
  updatedAt!: Date;
}
export type TreasuryBankAccountDocument = HydratedDocument<TreasuryBankAccountRecord>;
export const TreasuryBankAccountRecordSchema = SchemaFactory.createForClass(
  TreasuryBankAccountRecord,
);
TreasuryBankAccountRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
TreasuryBankAccountRecordSchema.index(
  { tenantId: 1, ownerType: 1, ownerId: 1, version: 1 }, { unique: true },
);
TreasuryBankAccountRecordSchema.index(
  { tenantId: 1, ownerType: 1, ownerId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
TreasuryBankAccountRecordSchema.index(
  { tenantId: 1, accountBlindIndexes: 1 }, { unique: true },
);

/** 员工级支付指令；账号快照、户名、清算行号和实发金额整体密文保存。 */
@Schema({
  collection: 'treasury_payment_instructions', timestamps: true, versionKey: false, id: false,
})
export class TreasuryPaymentInstructionRecord extends ProtectedTreasuryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) batchId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  payrollCalculationLineId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) bankAccountId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  instructionHash!: string;
  @Prop({
    type: String, required: true,
    enum: ['prepared', 'submitted', 'succeeded', 'failed', 'frozen'],
  })
  status!: 'prepared' | 'submitted' | 'succeeded' | 'failed' | 'frozen';
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  bankLineReference!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type TreasuryPaymentInstructionDocument =
  HydratedDocument<TreasuryPaymentInstructionRecord>;
export const TreasuryPaymentInstructionRecordSchema = SchemaFactory.createForClass(
  TreasuryPaymentInstructionRecord,
);
TreasuryPaymentInstructionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
TreasuryPaymentInstructionRecordSchema.index(
  { tenantId: 1, batchId: 1, employeeId: 1 }, { unique: true },
);
TreasuryPaymentInstructionRecordSchema.index(
  { tenantId: 1, batchId: 1, payrollCalculationLineId: 1 }, { unique: true },
);
TreasuryPaymentInstructionRecordSchema.index({ tenantId: 1, batchId: 1, status: 1 });

const BATCH_STATUSES: readonly DisbursementBatchStatus[] = [
  'prepared', 'exported', 'submitted', 'reconciling', 'frozen', 'reconciled',
];

/** 代发批次只保存控制总额、摘要和证据引用；绝不保存银行文件明文。 */
@Schema({ collection: 'treasury_disbursement_batches', timestamps: true, versionKey: false, id: false })
export class TreasuryDisbursementBatchRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  payrollPeriodId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) payrollRunId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) batchSequence!: number;
  @Prop({ type: String, default: null, immutable: true, match: ULID_PATTERN })
  parentBatchId!: string | null;
  @Prop({ type: String, required: true, immutable: true, enum: ['regular', 'supplement', 'recovery'] })
  purpose!: 'regular' | 'supplement' | 'recovery';
  @Prop({ type: String, required: true, immutable: true, enum: ['ISO20022_PAIN_001_001_03'] })
  format!: 'ISO20022_PAIN_001_001_03';
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) fileHash!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 5_000 }) lineCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) totalMinor!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  preparedBy!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  payrollLockedBy!: string;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  exportApprovedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  strongAuthEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  objectEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  bankSubmissionId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  bankSubmissionEvidenceId!: string | null;
  @Prop({ type: String, default: null, match: HASH_PATTERN }) returnHash!: string | null;
  @Prop({ type: Number, default: null, min: 0 }) successfulCount!: number | null;
  @Prop({ type: Number, default: null, min: 0 }) failedCount!: number | null;
  @Prop({ type: Number, default: null, min: 0 }) successfulMinor!: number | null;
  @Prop({ type: Number, default: null, min: 0 }) failedMinor!: number | null;
  @Prop({
    type: String, default: null,
    enum: [
      'SIGNATURE_INVALID', 'UNKNOWN_LINE', 'DUPLICATE_LINE',
      'COUNT_MISMATCH', 'AMOUNT_MISMATCH', 'PARTIAL_SUCCESS', null,
    ],
  })
  freezeReason!: string | null;
  @Prop({ type: String, required: true, enum: BATCH_STATUSES }) status!: DisbursementBatchStatus;
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type TreasuryDisbursementBatchDocument =
  HydratedDocument<TreasuryDisbursementBatchRecord>;
export const TreasuryDisbursementBatchRecordSchema = SchemaFactory.createForClass(
  TreasuryDisbursementBatchRecord,
);
TreasuryDisbursementBatchRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
TreasuryDisbursementBatchRecordSchema.index(
  { tenantId: 1, payrollRunId: 1, batchSequence: 1 }, { unique: true },
);
TreasuryDisbursementBatchRecordSchema.index({ tenantId: 1, payrollPeriodId: 1, status: 1 });
TreasuryDisbursementBatchRecordSchema.index(
  { tenantId: 1, parentBatchId: 1 },
  { partialFilterExpression: { parentBatchId: { $type: 'string' } } },
);

/** 银行回盘只保存受控对象、签名证据、摘要和汇总；原始正文不得进入 Mongo。 */
@Schema({ collection: 'treasury_bank_returns', timestamps: true, versionKey: false, id: false })
export class TreasuryBankReturnRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) batchId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) sequence!: number;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) returnHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  objectEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  signatureEvidenceId!: string;
  @Prop({ type: Boolean, required: true, immutable: true }) signatureVerified!: boolean;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) successfulCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) failedCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) unknownCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) duplicateCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) successfulMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) failedMinor!: number;
  @Prop({ type: String, required: true, immutable: true, enum: ['accepted', 'frozen'] })
  outcome!: 'accepted' | 'frozen';
  @Prop({ type: Date, required: true, immutable: true }) receivedAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type TreasuryBankReturnDocument = HydratedDocument<TreasuryBankReturnRecord>;
export const TreasuryBankReturnRecordSchema = SchemaFactory.createForClass(
  TreasuryBankReturnRecord,
);
TreasuryBankReturnRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
TreasuryBankReturnRecordSchema.index({ tenantId: 1, returnHash: 1 }, { unique: true });
TreasuryBankReturnRecordSchema.index(
  { tenantId: 1, batchId: 1, sequence: 1 }, { unique: true },
);
