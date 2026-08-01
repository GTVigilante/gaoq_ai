import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FAILURE_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/;

export type ESignIssuanceStatus =
  | 'pending'
  | 'processing'
  | 'local_finalize'
  | 'succeeded'
  | 'manual_review'
  | 'dead';

/**
 * eSign 发起意图。
 * 供应商文件和流程标识均为密文；记录不保存候选人姓名、账号、Offer 条款或签署链接。
 */
@Schema({
  collection: 'integration_esign_issuance_requests',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class ESignIssuanceRequestRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  offerId!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  offerVersion!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  providerFileKeyId!: string;

  @Prop({
    type: String, required: true, immutable: true,
    minlength: 16, maxlength: 16, match: BASE64URL_PATTERN,
  })
  providerFileIv!: string;

  @Prop({
    type: String, required: true, immutable: true,
    minlength: 1, maxlength: 1_024, match: BASE64URL_PATTERN,
  })
  providerFileCiphertext!: string;

  @Prop({
    type: String, required: true, immutable: true,
    minlength: 22, maxlength: 22, match: BASE64URL_PATTERN,
  })
  providerFileAuthTag!: string;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;

  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 10_000 })
  signaturePage!: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 100_000 })
  signatureX!: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 100_000 })
  signatureY!: number;

  @Prop({
    type: String,
    enum: [
      'pending', 'processing', 'local_finalize', 'succeeded', 'manual_review', 'dead',
    ],
    required: true,
  })
  status!: ESignIssuanceStatus;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  attempts!: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  lockedBy!: string | null;

  @Prop({ type: String, default: null, match: FAILURE_CODE_PATTERN })
  failureCode!: string | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  externalFlowKeyId!: string | null;

  @Prop({
    type: String, default: null, minlength: 16, maxlength: 16, match: BASE64URL_PATTERN,
  })
  externalFlowIv!: string | null;

  @Prop({
    type: String, default: null, minlength: 1, maxlength: 1_024, match: BASE64URL_PATTERN,
  })
  externalFlowCiphertext!: string | null;

  @Prop({
    type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN,
  })
  externalFlowAuthTag!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  flowId!: string | null;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  createdByActorId!: string;

  @Prop({ type: Number, required: true, default: 0, min: 0, max: 100 })
  operatorResolutionCount!: number;

  @Prop({ type: Date, default: null })
  operatorResolvedAt!: Date | null;

  @Prop({ type: Date, default: null })
  succeededAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ESignIssuanceRequestDocument = HydratedDocument<
  ESignIssuanceRequestRecord
>;
export const ESignIssuanceRequestRecordSchema = SchemaFactory.createForClass(
  ESignIssuanceRequestRecord,
);

ESignIssuanceRequestRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ESignIssuanceRequestRecordSchema.index({ tenantId: 1, offerId: 1 }, { unique: true });
ESignIssuanceRequestRecordSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
);
ESignIssuanceRequestRecordSchema.index(
  { tenantId: 1, status: 1, id: -1 },
);

ESignIssuanceRequestRecordSchema.pre('validate', function validateIssuanceState() {
  const externalFields = [
    this.externalFlowKeyId,
    this.externalFlowIv,
    this.externalFlowCiphertext,
    this.externalFlowAuthTag,
  ];
  const externalPresent = externalFields.every((value) => typeof value === 'string');
  const externalAbsent = externalFields.every((value) => value === null);
  const locked = this.status === 'processing';
  if (
    (!externalPresent && !externalAbsent) ||
    locked !== (this.lockedAt instanceof Date && typeof this.lockedBy === 'string') ||
    (['local_finalize', 'succeeded'].includes(this.status) && !externalPresent) ||
    (this.status === 'succeeded' && (
      this.flowId === null || !(this.succeededAt instanceof Date)
    )) ||
    (this.status !== 'succeeded' && (
      this.flowId !== null || this.succeededAt !== null
    ))
  ) {
    throw new Error('eSign 发起状态、租约、外部结果或终态字段不一致');
  }
});
