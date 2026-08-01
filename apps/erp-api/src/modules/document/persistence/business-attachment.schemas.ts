import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MIGRATION_REF =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const BUSINESS_ATTACHMENT_OWNER_TYPES = [
  'approval.instance', 'approval.history', 'recruitment.candidate',
  'recruitment.application', 'recruitment.interview', 'recruitment.offer',
  'org.employment',
] as const;
export type BusinessAttachmentOwnerType = typeof BUSINESS_ATTACHMENT_OWNER_TYPES[number];

export const BUSINESS_ATTACHMENT_PURPOSES = [
  'approval_attachment', 'approval_history_attachment', 'candidate_resume',
  'application_attachment', 'interview_attachment', 'offer_attachment',
  'employment_document',
] as const;
export type BusinessAttachmentPurpose = typeof BUSINESS_ATTACHMENT_PURPOSES[number];

/** 附件用途与归属实体一一绑定，迁移预检与领域写入共用同一白名单。 */
export const BUSINESS_ATTACHMENT_OWNER_BY_PURPOSE:
Readonly<Record<BusinessAttachmentPurpose, BusinessAttachmentOwnerType>> = Object.freeze({
  approval_attachment: 'approval.instance',
  approval_history_attachment: 'approval.history',
  candidate_resume: 'recruitment.candidate',
  application_attachment: 'recruitment.application',
  interview_attachment: 'recruitment.interview',
  offer_attachment: 'recruitment.offer',
  employment_document: 'org.employment',
});

/**
 * 通用业务附件仅保存受控元数据与对象证据引用；正文、原文件名和来源凭据永不进入 Mongo。
 */
@Schema({ collection: 'business_attachments', timestamps: true, versionKey: false, id: false })
export class BusinessAttachmentRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: BUSINESS_ATTACHMENT_OWNER_TYPES })
  ownerType!: BusinessAttachmentOwnerType;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  ownerId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: BUSINESS_ATTACHMENT_PURPOSES })
  purpose!: BusinessAttachmentPurpose;
  @Prop({ type: String, default: null, immutable: true, maxlength: 128, match: ID })
  uploadedByEmployeeId!: string | null;
  @Prop({ type: Date, required: true, immutable: true }) businessCreatedAt!: Date;
  @Prop({ type: String, required: true, immutable: true, match: HASH }) contentChecksum!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256, match: MIGRATION_REF })
  migrationEvidenceRef!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH })
  migrationEvidenceChecksum!: string;
  @Prop({ type: String, default: null, maxlength: 256, match: OBJECT_ID })
  objectEvidenceId!: string | null;
  @Prop({ type: Date, default: null }) availableAt!: Date | null;
  @Prop({ type: String, required: true, enum: ['migration_pending', 'available'] })
  status!: 'migration_pending' | 'available';
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type BusinessAttachmentDocument = HydratedDocument<BusinessAttachmentRecord>;
export const BusinessAttachmentRecordSchema = SchemaFactory.createForClass(
  BusinessAttachmentRecord,
);
BusinessAttachmentRecordSchema.pre('validate', function validateAvailability() {
  const available = this.status === 'available';
  if (available !== (this.objectEvidenceId !== null) || available !== (this.availableAt !== null)) {
    this.invalidate('status', '业务附件只能在取得对象证据后变为可用');
  }
  if (this.contentChecksum !== this.migrationEvidenceChecksum) {
    this.invalidate('contentChecksum', '业务附件内容摘要必须与迁移证据一致');
  }
});
BusinessAttachmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
BusinessAttachmentRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 }, { unique: true },
);
BusinessAttachmentRecordSchema.index({ tenantId: 1, ownerType: 1, ownerId: 1, businessCreatedAt: 1 });
BusinessAttachmentRecordSchema.index({ tenantId: 1, status: 1, updatedAt: 1 });
