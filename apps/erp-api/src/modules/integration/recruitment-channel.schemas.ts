import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const BLIND_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SECRET_REF_PATTERN = /^GAOQ_RECRUITMENT_CHANNEL_[A-Z0-9_]{1,96}$/;

/** 租户招聘渠道绑定；只保存 Secret Manager 引用和加密补拉游标。 */
@Schema({
  collection: 'integration_recruitment_channel_bindings',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentChannelBindingRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: CHANNEL_PATTERN })
  channelCode!: string;

  @Prop({ type: String, required: true, immutable: true, match: SECRET_REF_PATTERN })
  credentialSecretRef!: string;

  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';

  @Prop({ type: String, default: null, maxlength: 128 }) cursorKeyId!: string | null;
  @Prop({ type: String, default: null, maxlength: 32, match: BASE64URL_PATTERN }) cursorIv!: string | null;
  @Prop({ type: String, default: null, maxlength: 16_384, match: BASE64URL_PATTERN })
  cursorCiphertext!: string | null;
  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  cursorAuthTag!: string | null;

  @Prop({ type: Date, default: null }) lastPolledAt!: Date | null;
  @Prop({ type: Date, required: true }) nextPollAt!: Date;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  lastFailureCode!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentChannelBindingDocument = HydratedDocument<RecruitmentChannelBindingRecord>;
export const RecruitmentChannelBindingRecordSchema = SchemaFactory.createForClass(
  RecruitmentChannelBindingRecord,
);

RecruitmentChannelBindingRecordSchema.pre('validate', function () {
  const record = this as RecruitmentChannelBindingRecord;
  const cursor = [record.cursorKeyId, record.cursorIv, record.cursorCiphertext, record.cursorAuthTag];
  if (cursor.some((value) => value === null) && cursor.some((value) => value !== null)) {
    throw new Error('招聘渠道游标密文必须全有或全无');
  }
});

RecruitmentChannelBindingRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentChannelBindingRecordSchema.index({ tenantId: 1, channelCode: 1 }, { unique: true });
RecruitmentChannelBindingRecordSchema.index({ status: 1, nextPollAt: 1, id: 1 });

/** 外部标识映射；可枚举的供应商 ID 只保存密文和盲指纹。 */
@Schema({
  collection: 'integration_external_mappings', timestamps: true, versionKey: false, id: false,
})
export class RecruitmentExternalMappingRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: CHANNEL_PATTERN }) channelCode!: string;
  @Prop({
    type: String, enum: ['position', 'candidate', 'application'], required: true, immutable: true,
  })
  entityType!: 'position' | 'candidate' | 'application';
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) erpEntityId!: string;
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true })
  externalIdBlindIndexes!: string[];
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) externalIdKeyId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  externalIdIv!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 1_024, match: BASE64URL_PATTERN })
  externalIdCiphertext!: string;
  @Prop({
    type: String, required: true, immutable: true,
    minlength: 22, maxlength: 22, match: BASE64URL_PATTERN,
  })
  externalIdAuthTag!: string;
  @Prop({ type: String, enum: ['active', 'paused', 'closed'], required: true })
  status!: 'active' | 'paused' | 'closed';
  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentExternalMappingDocument = HydratedDocument<RecruitmentExternalMappingRecord>;
export const RecruitmentExternalMappingRecordSchema = SchemaFactory.createForClass(
  RecruitmentExternalMappingRecord,
);

RecruitmentExternalMappingRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentExternalMappingRecordSchema.index(
  { tenantId: 1, channelCode: 1, entityType: 1, externalIdBlindIndexes: 1 },
  { unique: true },
);
RecruitmentExternalMappingRecordSchema.index(
  { tenantId: 1, channelCode: 1, entityType: 1, erpEntityId: 1 },
  { unique: true },
);

export type RecruitmentChannelInboxStatus =
  | 'pending' | 'processing' | 'completed' | 'failed' | 'manual_review';

/** 渠道原始投递加密 Inbox；标准化和领域写入只在 Worker 中执行。 */
@Schema({
  collection: 'integration_recruitment_channel_inbox',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentChannelInboxRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) bindingId!: string;
  @Prop({ type: String, required: true, immutable: true, match: CHANNEL_PATTERN }) channelCode!: string;
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true })
  eventBlindIndexes!: string[];
  @Prop({ type: Date, required: true, immutable: true }) providerOccurredAt!: Date;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) payloadKeyId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  payloadIv!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 1_500_000, match: BASE64URL_PATTERN })
  payloadCiphertext!: string;
  @Prop({
    type: String, required: true, immutable: true,
    minlength: 22, maxlength: 22, match: BASE64URL_PATTERN,
  })
  payloadAuthTag!: string;
  @Prop({
    type: String, enum: ['pending', 'processing', 'completed', 'failed', 'manual_review'],
    required: true,
  })
  status!: RecruitmentChannelInboxStatus;
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: String, default: null, maxlength: 64 }) normalizerVersion!: string | null;
  @Prop({ type: Date, default: null }) evidenceVerifiedAt!: Date | null;
  @Prop({ type: String, default: null, match: ULID_PATTERN }) applicationId!: string | null;
  @Prop({ type: String, default: null, match: ULID_PATTERN }) consentEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 128 }) resumeSnapshotId!: string | null;
  @Prop({ type: String, default: null, match: BLIND_INDEX_PATTERN })
  acknowledgementFingerprint!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentChannelInboxDocument = HydratedDocument<RecruitmentChannelInboxRecord>;
export const RecruitmentChannelInboxRecordSchema = SchemaFactory.createForClass(
  RecruitmentChannelInboxRecord,
);

RecruitmentChannelInboxRecordSchema.pre('validate', function () {
  const record = this as RecruitmentChannelInboxRecord;
  if (record.eventBlindIndexes.length === 0) throw new Error('渠道 Inbox 必须包含去重指纹');
  if (record.evidenceVerifiedAt !== null && (
    record.consentEvidenceId === null || record.normalizerVersion === null
  )) throw new Error('渠道 Inbox 证据检查点不完整');
  if (record.status === 'completed' && (
    record.applicationId === null || record.consentEvidenceId === null ||
    record.normalizerVersion === null || record.acknowledgementFingerprint === null ||
    record.evidenceVerifiedAt === null || record.processedAt === null || record.failureCode !== null
  )) throw new Error('已完成渠道 Inbox 缺少证据或申请引用');
});

RecruitmentChannelInboxRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentChannelInboxRecordSchema.index(
  { tenantId: 1, channelCode: 1, eventBlindIndexes: 1 }, { unique: true },
);
RecruitmentChannelInboxRecordSchema.index({ status: 1, processingStartedAt: 1, createdAt: 1 });
RecruitmentChannelInboxRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });

export type RecruitmentChannelPositionDeliveryStatus =
  | 'pending' | 'processing' | 'succeeded' | 'superseded' | 'dead' | 'manual_review';

/** 职位发布/下架投递轨迹；只存领域引用和脱敏回执。 */
@Schema({
  collection: 'integration_recruitment_channel_position_deliveries',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentChannelPositionDeliveryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) eventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) bindingId!: string;
  @Prop({ type: String, required: true, immutable: true, match: CHANNEL_PATTERN }) channelCode!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) positionId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) positionVersion!: number;
  @Prop({ type: String, enum: ['publish', 'close'], required: true, immutable: true })
  action!: 'publish' | 'close';
  @Prop({ type: String, enum: ['open', 'paused', 'closed'], required: true, immutable: true })
  targetStatus!: 'open' | 'paused' | 'closed';
  @Prop({
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'superseded', 'dead', 'manual_review'],
    required: true,
  })
  status!: RecruitmentChannelPositionDeliveryStatus;
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: Date, required: true }) nextAttemptAt!: Date;
  @Prop({ type: Date, default: null }) lockedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 }) lockedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: String, default: null, match: BLIND_INDEX_PATTERN })
  receiptFingerprint!: string | null;
  @Prop({ type: Date, default: null }) succeededAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentChannelPositionDeliveryDocument = HydratedDocument<
  RecruitmentChannelPositionDeliveryRecord
>;
export const RecruitmentChannelPositionDeliveryRecordSchema = SchemaFactory.createForClass(
  RecruitmentChannelPositionDeliveryRecord,
);

RecruitmentChannelPositionDeliveryRecordSchema.index(
  { tenantId: 1, eventId: 1, bindingId: 1 }, { unique: true },
);
RecruitmentChannelPositionDeliveryRecordSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
);
RecruitmentChannelPositionDeliveryRecordSchema.index(
  { tenantId: 1, positionId: 1, channelCode: 1, positionVersion: 1 },
);

export type RecruitmentChannelStageDeliveryStatus =
  'pending' | 'processing' | 'succeeded' | 'skipped' | 'dead';

/** 申请阶段回传轨迹；不复制候选人身份、淘汰原因或招聘内部证据。 */
@Schema({
  collection: 'integration_recruitment_channel_stage_deliveries',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentChannelStageDeliveryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) eventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) applicationId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 2 }) applicationVersion!: number;
  @Prop({
    type: String,
    enum: ['screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'],
    required: true,
    immutable: true,
  })
  stage!: 'screening' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
  @Prop({
    type: String, enum: ['pending', 'processing', 'succeeded', 'skipped', 'dead'], required: true,
  })
  status!: RecruitmentChannelStageDeliveryStatus;
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: Date, required: true }) nextAttemptAt!: Date;
  @Prop({ type: Date, default: null }) lockedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 }) lockedBy!: string | null;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: String, default: null, match: BLIND_INDEX_PATTERN })
  receiptFingerprint!: string | null;
  @Prop({ type: Date, default: null }) succeededAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentChannelStageDeliveryDocument = HydratedDocument<
  RecruitmentChannelStageDeliveryRecord
>;
export const RecruitmentChannelStageDeliveryRecordSchema = SchemaFactory.createForClass(
  RecruitmentChannelStageDeliveryRecord,
);

RecruitmentChannelStageDeliveryRecordSchema.index(
  { tenantId: 1, eventId: 1 }, { unique: true },
);
RecruitmentChannelStageDeliveryRecordSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
);
RecruitmentChannelStageDeliveryRecordSchema.index(
  { tenantId: 1, applicationId: 1, applicationVersion: 1 }, { unique: true },
);
