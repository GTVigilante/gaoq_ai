import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const BLIND_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

@Schema({
  collection: 'integration_attendance_provider_states',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceProviderStateRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  providerCode!: 'dingtalk' | 'feishu';
  @Prop({ type: String, required: true, default: 'Asia/Shanghai', maxlength: 64 })
  timeZone!: string;
  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';
  @Prop({ type: String, default: null, maxlength: 128 }) cursorKeyId!: string | null;
  @Prop({ type: String, default: null, maxlength: 32, match: BASE64URL_PATTERN })
  cursorIv!: string | null;
  @Prop({ type: String, default: null, maxlength: 4_096, match: BASE64URL_PATTERN })
  cursorCiphertext!: string | null;
  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  cursorAuthTag!: string | null;
  @Prop({ type: Date, default: null }) lastPolledAt!: Date | null;
  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ })
  committedThroughDate!: string | null;
  @Prop({ type: Date, required: true }) nextPollAt!: Date;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  lastFailureCode!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceProviderStateDocument = HydratedDocument<AttendanceProviderStateRecord>;
export const AttendanceProviderStateRecordSchema = SchemaFactory.createForClass(
  AttendanceProviderStateRecord,
);
AttendanceProviderStateRecordSchema.pre('validate', function () {
  const record = this as AttendanceProviderStateRecord;
  const parts = [record.cursorKeyId, record.cursorIv, record.cursorCiphertext, record.cursorAuthTag];
  if (parts.some((value) => value === null) && parts.some((value) => value !== null)) {
    throw new Error('考勤 Provider 游标密文必须全有或全无');
  }
});
AttendanceProviderStateRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceProviderStateRecordSchema.index({ tenantId: 1, providerCode: 1 }, { unique: true });
AttendanceProviderStateRecordSchema.index({ status: 1, nextPollAt: 1, id: 1 });

/** 外部员工标识只保存盲索引和密文；员工主键始终来自 ERP 主数据。 */
@Schema({
  collection: 'integration_attendance_employee_mappings',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceProviderEmployeeMappingRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  providerCode!: 'dingtalk' | 'feishu';
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) employeeId!: string;
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true })
  externalIdBlindIndexes!: string[];
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  externalIdKeyId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  externalIdIv!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 1_024, match: BASE64URL_PATTERN })
  externalIdCiphertext!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  externalIdAuthTag!: string;
  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceProviderEmployeeMappingDocument = HydratedDocument<
  AttendanceProviderEmployeeMappingRecord
>;
export const AttendanceProviderEmployeeMappingRecordSchema = SchemaFactory.createForClass(
  AttendanceProviderEmployeeMappingRecord,
);
AttendanceProviderEmployeeMappingRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceProviderEmployeeMappingRecordSchema.index(
  { tenantId: 1, providerCode: 1, employeeId: 1 }, { unique: true },
);
AttendanceProviderEmployeeMappingRecordSchema.index(
  { tenantId: 1, providerCode: 1, externalIdBlindIndexes: 1 }, { unique: true },
);

export type AttendanceProviderInboxStatus =
  | 'pending' | 'processing' | 'completed' | 'failed' | 'manual_review';

@Schema({
  collection: 'integration_attendance_provider_inbox',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceProviderInboxRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) stateId!: string;
  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  providerCode!: 'dingtalk' | 'feishu';
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true })
  eventBlindIndexes!: string[];
  @Prop({ type: Date, required: true, immutable: true }) providerOccurredAt!: Date;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) payloadKeyId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  payloadIv!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 1_500_000, match: BASE64URL_PATTERN })
  payloadCiphertext!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  payloadAuthTag!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  transportRequestIdFingerprint!: string;
  @Prop({ type: String, enum: ['pending', 'processing', 'completed', 'failed', 'manual_review'], required: true })
  status!: AttendanceProviderInboxStatus;
  @Prop({ type: Number, required: true, min: 0, max: 100 }) attempts!: number;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;
  @Prop({ type: String, default: null, maxlength: 64 }) normalizerVersion!: string | null;
  @Prop({ type: Date, default: null }) evidenceVerifiedAt!: Date | null;
  @Prop({ type: String, default: null, match: ULID_PATTERN }) sourceFactId!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceProviderInboxDocument = HydratedDocument<AttendanceProviderInboxRecord>;
export const AttendanceProviderInboxRecordSchema = SchemaFactory.createForClass(
  AttendanceProviderInboxRecord,
);
AttendanceProviderInboxRecordSchema.pre('validate', function () {
  const record = this as AttendanceProviderInboxRecord;
  if (record.eventBlindIndexes.length === 0) throw new Error('考勤 Provider Inbox 缺少事件指纹');
  if (record.status === 'completed' && (
    record.sourceFactId === null || record.processedAt === null ||
    record.evidenceVerifiedAt === null || record.normalizerVersion === null ||
    record.failureCode !== null
  )) throw new Error('已完成考勤 Provider Inbox 检查点不完整');
});
AttendanceProviderInboxRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceProviderInboxRecordSchema.index(
  { tenantId: 1, providerCode: 1, eventBlindIndexes: 1 }, { unique: true },
);
AttendanceProviderInboxRecordSchema.index({ status: 1, processingStartedAt: 1, createdAt: 1 });
AttendanceProviderInboxRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
