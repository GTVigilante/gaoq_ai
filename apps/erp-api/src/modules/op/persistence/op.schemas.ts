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

/** OP 来源单据到 ERP 审批模板的受控路由，同时持有独立结果回推凭据引用。 */
@Schema({ collection: 'op_approval_routes', timestamps: true, versionKey: false, id: false })
export class OpApprovalRouteRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  inboundClientId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  externalTenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: /^[a-z][a-z0-9._-]+$/ })
  sourceDocumentType!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ })
  templateCode!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  outboundClientId!: string;
  @Prop({
    type: String, required: true, immutable: true,
    match: /^GAOQ_OP_APPROVAL_OUTBOUND_[A-Z0-9_]{1,96}$/,
  })
  outboundCredentialSecretRef!: string;
  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpApprovalRouteDocument = HydratedDocument<OpApprovalRouteRecord>;
export const OpApprovalRouteRecordSchema = SchemaFactory.createForClass(OpApprovalRouteRecord);
OpApprovalRouteRecordSchema.index(
  { tenantId: 1, inboundClientId: 1, sourceDocumentType: 1 }, { unique: true },
);
OpApprovalRouteRecordSchema.index({ tenantId: 1, status: 1, sourceDocumentType: 1 });

/** OP 审批请求加密 Inbox；原始表单只以 AES-256-GCM 密文短期保存。 */
@Schema({ collection: 'op_approval_request_inbox', timestamps: true, versionKey: false, id: false })
export class OpApprovalRequestInboxRecord {
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
  @Prop({ type: String, enum: ['pending', 'processing', 'completed', 'failed'], required: true })
  status!: 'pending' | 'processing' | 'completed' | 'failed';
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: Date, default: null }) processedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpApprovalRequestInboxDocument = HydratedDocument<OpApprovalRequestInboxRecord>;
export const OpApprovalRequestInboxRecordSchema = SchemaFactory.createForClass(
  OpApprovalRequestInboxRecord,
);
OpApprovalRequestInboxRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OpApprovalRequestInboxRecordSchema.index(
  { tenantId: 1, clientId: 1, externalEventId: 1 }, { unique: true },
);
OpApprovalRequestInboxRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** OP 来源单据与 ERP 审批实例的长期、非敏感关联。 */
@Schema({ collection: 'op_approval_bridges', timestamps: true, versionKey: false, id: false })
export class OpApprovalBridgeRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) clientId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  externalEventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: /^[a-z][a-z0-9._-]+$/ })
  sourceDocumentType!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  sourceDocumentId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) templateCode!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  approvalInstanceId!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL })
  payloadHash!: string;
  @Prop({
    type: String, enum: ['processing', 'running', 'approved', 'rejected', 'withdrawn'],
    required: true,
  })
  approvalStatus!: 'processing' | 'running' | 'approved' | 'rejected' | 'withdrawn';
  @Prop({ type: Number, required: true, min: 0 }) approvalVersion!: number;
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpApprovalBridgeDocument = HydratedDocument<OpApprovalBridgeRecord>;
export const OpApprovalBridgeRecordSchema = SchemaFactory.createForClass(OpApprovalBridgeRecord);
OpApprovalBridgeRecordSchema.index(
  { tenantId: 1, clientId: 1, externalEventId: 1 }, { unique: true },
);
OpApprovalBridgeRecordSchema.index({ tenantId: 1, externalEventId: 1 }, { unique: true });
OpApprovalBridgeRecordSchema.index(
  { tenantId: 1, clientId: 1, sourceDocumentType: 1, sourceDocumentId: 1 }, { unique: true },
);
OpApprovalBridgeRecordSchema.index(
  { tenantId: 1, sourceDocumentType: 1, sourceDocumentId: 1 }, { unique: true },
);
OpApprovalBridgeRecordSchema.index({ tenantId: 1, approvalInstanceId: 1 }, { unique: true });

/** ERP 审批终态到 OP 的可靠投递轨迹，不保存表单正文。 */
@Schema({ collection: 'op_approval_result_deliveries', timestamps: true, versionKey: false, id: false })
export class OpApprovalResultDeliveryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) eventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) clientId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  externalEventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) sourceDocumentType!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  sourceDocumentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  approvalInstanceId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) approvalVersion!: number;
  @Prop({ type: String, enum: ['approved', 'rejected', 'withdrawn'], required: true, immutable: true })
  result!: 'approved' | 'rejected' | 'withdrawn';
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
  @Prop({ type: String, enum: ['pending', 'processing', 'succeeded', 'dead', 'manual_review'], required: true })
  status!: 'pending' | 'processing' | 'succeeded' | 'dead' | 'manual_review';
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: Number, required: true, default: 0, min: 0, max: 100 })
  operatorRetryCount!: number;
  @Prop({ type: Date, required: true }) nextAttemptAt!: Date;
  @Prop({ type: Date, default: null }) lockedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 }) lockedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_:-]+$/ })
  lastErrorCode!: string | null;
  @Prop({ type: Date, default: null }) succeededAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type OpApprovalResultDeliveryDocument = HydratedDocument<OpApprovalResultDeliveryRecord>;
export const OpApprovalResultDeliveryRecordSchema = SchemaFactory.createForClass(
  OpApprovalResultDeliveryRecord,
);
OpApprovalResultDeliveryRecordSchema.index({ eventId: 1 }, { unique: true });
OpApprovalResultDeliveryRecordSchema.index(
  { tenantId: 1, approvalInstanceId: 1, approvalVersion: 1 }, { unique: true },
);
OpApprovalResultDeliveryRecordSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
OpApprovalResultDeliveryRecordSchema.index({ tenantId: 1, status: 1, eventId: -1 });
