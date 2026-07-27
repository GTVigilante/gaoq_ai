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
