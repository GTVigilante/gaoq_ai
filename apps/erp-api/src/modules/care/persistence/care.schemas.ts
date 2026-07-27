import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const MAX_ID = 128;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

@Schema({ collection: 'care_cases', timestamps: true, versionKey: false, id: false })
export class CareCaseRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) employmentId!: string;
  @Prop({
    type: String,
    enum: ['voluntary_resignation', 'involuntary_termination', 'retirement', 'contract_end'],
    required: true,
    immutable: true,
  })
  separationType!: 'voluntary_resignation' | 'involuntary_termination' | 'retirement' | 'contract_end';
  @Prop({ type: String, required: true, immutable: true, match: /^[A-Z][A-Z0-9_]{1,63}$/ })
  reasonCode!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  lastWorkingDate!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) tenantTimeZone!: string;
  @Prop({ type: Date, required: true, immutable: true }) accessDisableAt!: Date;
  @Prop({
    type: String,
    enum: [
      'draft', 'pending_approval', 'approved', 'clearing', 'ready',
      'scheduled', 'executing', 'completed', 'cancelled',
    ],
    required: true,
  })
  status!: 'draft' | 'pending_approval' | 'approved' | 'clearing' | 'ready' |
    'scheduled' | 'executing' | 'completed' | 'cancelled';
  @Prop({ type: String, default: null, maxlength: MAX_ID }) approvalInstanceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) handoverEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) assetsEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) financeEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) retentionEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) executionEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) orgTerminationEvidenceId!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type CareCaseDocument = HydratedDocument<CareCaseRecord>;
export const CareCaseRecordSchema = SchemaFactory.createForClass(CareCaseRecord);
CareCaseRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CareCaseRecordSchema.index(
  { tenantId: 1, employmentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [
      'draft', 'pending_approval', 'approved', 'clearing', 'ready', 'scheduled', 'executing',
    ] } },
  },
);
CareCaseRecordSchema.index({ tenantId: 1, status: 1, accessDisableAt: 1 });
CareCaseRecordSchema.index(
  { tenantId: 1, approvalInstanceId: 1 },
  { unique: true, partialFilterExpression: { approvalInstanceId: { $type: 'string' } } },
);

@Schema({ collection: 'care_task_evidence', timestamps: true, versionKey: false, id: false })
export class CareTaskEvidenceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) careCaseId!: string;
  @Prop({
    type: String,
    enum: ['handover_accepted', 'assets_cleared', 'finance_cleared', 'data_retention_confirmed'],
    required: true,
    immutable: true,
  })
  taskCode!: 'handover_accepted' | 'assets_cleared' | 'finance_cleared' |
    'data_retention_confirmed';
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) evidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) actorId!: string;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
}
export type CareTaskEvidenceDocument = HydratedDocument<CareTaskEvidenceRecord>;
export const CareTaskEvidenceRecordSchema = SchemaFactory.createForClass(CareTaskEvidenceRecord);
CareTaskEvidenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CareTaskEvidenceRecordSchema.index(
  { tenantId: 1, careCaseId: 1, taskCode: 1 }, { unique: true },
);

@Schema({ collection: 'care_alumni_consents', timestamps: true, versionKey: false, id: false })
export class CareAlumniConsentRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) personId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) careCaseId!: string;
  @Prop({ type: String, enum: ['alumni_network', 'rehire_contact', 'alumni_events'], required: true })
  purpose!: 'alumni_network' | 'rehire_contact' | 'alumni_events';
  @Prop({ type: [String], enum: ['email', 'sms', 'phone', 'wechat'], required: true })
  channels!: ('email' | 'sms' | 'phone' | 'wechat')[];
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) consentVersion!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  consentEvidenceId!: string;
  @Prop({ type: Date, required: true, immutable: true }) grantedAt!: Date;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: Date, default: null }) withdrawnAt!: Date | null;
  @Prop({ type: Date, default: null }) expiredAt!: Date | null;
  @Prop({ type: String, enum: ['active', 'withdrawn', 'expired'], required: true })
  status!: 'active' | 'withdrawn' | 'expired';
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
}
export type CareAlumniConsentDocument = HydratedDocument<CareAlumniConsentRecord>;
export const CareAlumniConsentRecordSchema = SchemaFactory.createForClass(CareAlumniConsentRecord);
CareAlumniConsentRecordSchema.pre('validate', function validateConsentState() {
  if (!(this.grantedAt instanceof Date) || !(this.expiresAt instanceof Date)) return;
  if (this.expiresAt.getTime() <= this.grantedAt.getTime()) {
    this.invalidate('expiresAt', '校友授权到期时间必须晚于授予时间');
  }
  const active = this.status === 'active' && this.withdrawnAt === null && this.expiredAt === null;
  const withdrawn = this.status === 'withdrawn' &&
    this.withdrawnAt instanceof Date && this.expiredAt === null;
  const expired = this.status === 'expired' &&
    this.withdrawnAt === null && this.expiredAt instanceof Date &&
    this.expiredAt.getTime() >= this.expiresAt.getTime();
  if (!active && !withdrawn && !expired) {
    this.invalidate('status', '校友授权状态与终止时间不一致');
  }
});
CareAlumniConsentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CareAlumniConsentRecordSchema.index({ tenantId: 1, consentEvidenceId: 1 }, { unique: true });
CareAlumniConsentRecordSchema.index(
  { tenantId: 1, personId: 1, purpose: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
CareAlumniConsentRecordSchema.index({ tenantId: 1, status: 1, expiresAt: 1 });

export type CareOccasionChannelRecord = 'email' | 'sms' | 'feishu' | 'dingtalk';
export type CareOccasionTaskStatusRecord =
  | 'pending'
  | 'dispatching'
  | 'delivered'
  | 'cancelled'
  | 'dead';

@Schema({
  collection: 'care_occasion_preferences',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class CareOccasionPreferenceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  personId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  employeeId!: string;
  @Prop({ type: String, required: true, maxlength: MAX_ID })
  currentEmploymentId!: string;
  @Prop({ type: Boolean, required: true }) birthdayEnabled!: boolean;
  @Prop({ type: Boolean, required: true }) anniversaryEnabled!: boolean;
  @Prop({
    type: [String],
    enum: ['email', 'sms', 'feishu', 'dingtalk'],
    required: true,
    validate: {
      validator: (value: string[]): boolean =>
        value.length <= 4 && new Set(value).size === value.length,
      message: '关怀偏好渠道必须去重且不超过四个',
    },
  })
  preferredChannels!: CareOccasionChannelRecord[];
  @Prop({ type: Boolean, required: true }) unsubscribed!: boolean;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type CareOccasionPreferenceDocument =
  HydratedDocument<CareOccasionPreferenceRecord>;
export const CareOccasionPreferenceRecordSchema =
  SchemaFactory.createForClass(CareOccasionPreferenceRecord);
CareOccasionPreferenceRecordSchema.pre('validate', function validatePreferenceState() {
  if (this.unsubscribed) {
    if (
      this.birthdayEnabled ||
      this.anniversaryEnabled ||
      this.preferredChannels.length !== 0
    ) this.invalidate('unsubscribed', '全局退订必须关闭全部关怀并清空渠道');
    return;
  }
  if (
    (this.birthdayEnabled || this.anniversaryEnabled) &&
    this.preferredChannels.length === 0
  ) this.invalidate('preferredChannels', '启用关怀必须选择偏好渠道');
});
CareOccasionPreferenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CareOccasionPreferenceRecordSchema.index(
  { tenantId: 1, employeeId: 1 },
  { unique: true },
);
CareOccasionPreferenceRecordSchema.index({
  tenantId: 1,
  unsubscribed: 1,
  employeeId: 1,
});

@Schema({
  collection: 'care_occasion_tasks',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class CareOccasionTaskRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  personId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  employeeId!: string;
  @Prop({ type: String, required: true, maxlength: MAX_ID })
  employmentId!: string;
  @Prop({
    type: String,
    enum: ['birthday', 'employment_anniversary'],
    required: true,
    immutable: true,
  })
  occasionType!: 'birthday' | 'employment_anniversary';
  @Prop({ type: Number, required: true, immutable: true, min: 2000, max: 2200 })
  occurrenceYear!: number;
  @Prop({ type: Date, required: true }) scheduledAt!: Date;
  @Prop({ type: String, required: true, maxlength: 64, match: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ })
  templateCode!: string;
  @Prop({ type: String, required: true, maxlength: 64, match: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ })
  policyVersion!: string;
  @Prop({
    type: [String],
    enum: ['email', 'sms', 'feishu', 'dingtalk'],
    required: true,
    validate: {
      validator: (value: string[]): boolean =>
        value.length >= 1 && value.length <= 4 && new Set(value).size === value.length,
      message: '关怀任务偏好渠道必须为 1..4 个去重值',
    },
  })
  preferredChannels!: CareOccasionChannelRecord[];
  @Prop({ type: String, required: true, maxlength: 43, match: /^[A-Za-z0-9_-]{43}$/ })
  sourceDigest!: string;
  @Prop({
    type: String,
    enum: ['pending', 'dispatching', 'delivered', 'cancelled', 'dead'],
    required: true,
  })
  status!: CareOccasionTaskStatusRecord;
  @Prop({ type: Number, required: true, min: 0, max: 12 }) attempts!: number;
  @Prop({ type: Date, required: true }) nextAttemptAt!: Date;
  @Prop({ type: Date, default: null }) lockedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) lockedBy!: string | null;
  @Prop({
    type: String,
    enum: [
      'unsubscribed',
      'no_authorized_channel',
      'purpose_restricted',
      'quiet_hours',
    ],
    default: null,
  })
  denialCode!:
    | 'unsubscribed'
    | 'no_authorized_channel'
    | 'purpose_restricted'
    | 'quiet_hours'
    | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID })
  deliveryEvidenceId!: string | null;
  @Prop({ type: Date, default: null }) deliveredAt!: Date | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type CareOccasionTaskDocument = HydratedDocument<CareOccasionTaskRecord>;
export const CareOccasionTaskRecordSchema =
  SchemaFactory.createForClass(CareOccasionTaskRecord);
CareOccasionTaskRecordSchema.pre('validate', function validateOccasionTaskState() {
  const locked =
    this.status === 'dispatching' &&
    this.lockedAt instanceof Date &&
    typeof this.lockedBy === 'string';
  const unlocked =
    this.status !== 'dispatching' &&
    this.lockedAt === null &&
    this.lockedBy === null;
  const delivered =
    this.status === 'delivered' &&
    this.deliveryEvidenceId !== null &&
    this.deliveredAt instanceof Date &&
    this.denialCode === null;
  const denied =
    this.status === 'cancelled' &&
    this.denialCode !== null &&
    this.deliveryEvidenceId === null &&
    this.deliveredAt === null;
  const openOrDead =
    ['pending', 'dispatching', 'dead'].includes(this.status) &&
    this.denialCode === null &&
    this.deliveryEvidenceId === null &&
    this.deliveredAt === null;
  if (!locked && !unlocked) this.invalidate('status', '关怀任务锁与状态不一致');
  if (!delivered && !denied && !openOrDead) {
    this.invalidate('status', '关怀任务终态证据组合非法');
  }
});
CareOccasionTaskRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CareOccasionTaskRecordSchema.index(
  { tenantId: 1, employeeId: 1, occasionType: 1, occurrenceYear: 1 },
  { unique: true },
);
CareOccasionTaskRecordSchema.index({
  tenantId: 1,
  status: 1,
  nextAttemptAt: 1,
  scheduledAt: 1,
  id: 1,
});
CareOccasionTaskRecordSchema.index({ status: 1, lockedAt: 1 });
CareOccasionTaskRecordSchema.index(
  { tenantId: 1, deliveryEvidenceId: 1 },
  {
    unique: true,
    partialFilterExpression: { deliveryEvidenceId: { $type: 'string' } },
  },
);

/** Worker 仅用该最小注册表枚举已启用 Care 租户，再进入各自可信上下文。 */
@Schema({
  collection: 'care_occasion_tenants',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class CareOccasionTenantRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  tenantId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type CareOccasionTenantDocument = HydratedDocument<CareOccasionTenantRecord>;
export const CareOccasionTenantRecordSchema =
  SchemaFactory.createForClass(CareOccasionTenantRecord);
CareOccasionTenantRecordSchema.index({ tenantId: 1 }, { unique: true });
