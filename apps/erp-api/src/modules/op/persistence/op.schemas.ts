import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const nonnegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const positiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000;

/** OP 客户端到租户的唯一受信绑定；数据库只保存 Secret Manager 引用。 */
@Schema({ collection: 'op_client_bindings', timestamps: true, versionKey: false, id: false })
export class OpClientBindingRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 4, maxlength: 128, match: ID })
  clientId!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^GAOQ_OP_HMAC_[A-Z0-9_]{1,96}$/ })
  credentialSecretRef!: string;
  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpClientBindingDocument = HydratedDocument<OpClientBindingRecord>;
export const OpClientBindingRecordSchema = SchemaFactory.createForClass(OpClientBindingRecord);
OpClientBindingRecordSchema.index({ clientId: 1 }, { unique: true });
OpClientBindingRecordSchema.index({ tenantId: 1, clientId: 1 }, { unique: true });

/** OP 原始请求加密 Inbox；nonce 只保留 SHA-256 摘要。 */
@Schema({ collection: 'op_operating_summary_inbox', timestamps: true, versionKey: false, id: false })
export class OpOperatingSummaryInboxRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) clientId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  externalEventId!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL })
  nonceHash!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL })
  payloadHash!: string;
  @Prop({ type: Date, required: true, immutable: true }) providerOccurredAt!: Date;
  @Prop({ type: Date, required: true, immutable: true }) receivedAt!: Date;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) payloadKeyId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL }) payloadIv!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 1_500_000, match: BASE64URL })
  payloadCiphertext!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22, match: BASE64URL })
  payloadAuthTag!: string;
  @Prop({ type: String, enum: ['pending', 'processing', 'completed', 'ignored', 'failed'], required: true })
  status!: 'pending' | 'processing' | 'completed' | 'ignored' | 'failed';
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: Date, default: null }) processedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpOperatingSummaryInboxDocument = HydratedDocument<OpOperatingSummaryInboxRecord>;
export const OpOperatingSummaryInboxRecordSchema = SchemaFactory.createForClass(
  OpOperatingSummaryInboxRecord,
);
OpOperatingSummaryInboxRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OpOperatingSummaryInboxRecordSchema.index(
  { tenantId: 1, clientId: 1, externalEventId: 1 }, { unique: true },
);
OpOperatingSummaryInboxRecordSchema.index(
  { tenantId: 1, clientId: 1, nonceHash: 1 }, { unique: true },
);
OpOperatingSummaryInboxRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
OpOperatingSummaryInboxRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** 不可变 OP 每日经营摘要修订；查询通过固定索引选择最新 revision。 */
@Schema({ collection: 'op_operating_summaries', timestamps: true, versionKey: false, id: false })
export class OpOperatingSummaryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  summaryDate!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positiveSafeInteger } })
  revision!: number;
  @Prop({ type: String, enum: ['CNY'], required: true, immutable: true }) currency!: 'CNY';
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: nonnegativeSafeInteger } })
  gmvMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: nonnegativeSafeInteger } })
  paidOrderCount!: number;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: nonnegativeSafeInteger } })
  refundMinor!: number;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: nonnegativeSafeInteger } })
  refundOrderCount!: number;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: nonnegativeSafeInteger } })
  activeCustomerCount!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) clientId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  externalEventId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) inboxId!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL })
  payloadHash!: string;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
  @Prop({ type: Date, required: true, immutable: true }) receivedAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpOperatingSummaryDocument = HydratedDocument<OpOperatingSummaryRecord>;
export const OpOperatingSummaryRecordSchema = SchemaFactory.createForClass(OpOperatingSummaryRecord);
OpOperatingSummaryRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OpOperatingSummaryRecordSchema.index(
  { tenantId: 1, summaryDate: 1, revision: 1 }, { unique: true },
);
OpOperatingSummaryRecordSchema.index(
  { tenantId: 1, clientId: 1, externalEventId: 1 }, { unique: true },
);
OpOperatingSummaryRecordSchema.index({ tenantId: 1, summaryDate: 1, revision: -1 });
