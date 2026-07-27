import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';
import {
  MARKETING_CONTENT_TYPES,
  MARKETING_LOCALES,
  MARKETING_STATUSES,
  type MarketingBlock,
  type MarketingContentType,
  type MarketingLocale,
  type MarketingStatus,
} from './marketing-cms.types.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

@Schema({ collection: 'marketing_contents', timestamps: true, versionKey: false, id: false })
export class MarketingContentRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) siteId!: string;
  @Prop({ type: String, enum: MARKETING_CONTENT_TYPES, required: true }) type!: MarketingContentType;
  @Prop({ type: String, enum: MARKETING_LOCALES, required: true }) locale!: MarketingLocale;
  @Prop({ type: String, required: true, maxlength: 160 }) slug!: string;
  @Prop({ type: String, required: true, maxlength: 160 }) title!: string;
  @Prop({ type: String, default: '', maxlength: 500 }) summary!: string;
  @Prop({ type: [MongooseSchema.Types.Mixed], required: true }) blocks!: MarketingBlock[];
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) seo!: Record<string, string>;
  @Prop({ type: String, enum: MARKETING_STATUSES, required: true }) status!: MarketingStatus;
  @Prop({ type: Number, required: true, min: 1 }) revision!: number;
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  @Prop({ type: Date, default: null }) publishedAt!: Date | null;
  @Prop({ type: Date, default: null }) scheduledAt!: Date | null;
  @Prop({ type: String, required: true, maxlength: 128 }) updatedBy!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type MarketingContentDocument = HydratedDocument<MarketingContentRecord>;
export const MarketingContentRecordSchema = SchemaFactory.createForClass(MarketingContentRecord);
MarketingContentRecordSchema.index(
  { tenantId: 1, siteId: 1, locale: 1, type: 1, slug: 1 },
  { unique: true },
);
MarketingContentRecordSchema.index({ tenantId: 1, siteId: 1, status: 1, updatedAt: -1 });

@Schema({ collection: 'marketing_content_revisions', timestamps: true, versionKey: false, id: false })
export class MarketingContentRevisionRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) contentId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) revision!: number;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true, immutable: true }) snapshot!: Record<string, unknown>;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) actorId!: string;
  createdAt!: Date;
}
export type MarketingContentRevisionDocument = HydratedDocument<MarketingContentRevisionRecord>;
export const MarketingContentRevisionRecordSchema =
  SchemaFactory.createForClass(MarketingContentRevisionRecord);
MarketingContentRevisionRecordSchema.index(
  { tenantId: 1, contentId: 1, revision: 1 },
  { unique: true },
);

@Schema({ collection: 'marketing_leads', timestamps: true, versionKey: false, id: false })
export class MarketingLeadRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) siteId!: string;
  @Prop({ type: String, enum: ['creator', 'brand'], required: true, immutable: true })
  audience!: 'creator' | 'brand';
  @Prop({ type: String, required: true, maxlength: 100 }) name!: string;
  @Prop({
    type: String,
    required: true,
    minlength: 16,
    maxlength: 16,
    match: BASE64URL,
    select: false,
  })
  contactIv!: string;
  @Prop({
    type: String,
    required: true,
    minlength: 7,
    maxlength: 1016,
    match: BASE64URL,
    select: false,
  })
  contactCiphertext!: string;
  @Prop({
    type: String,
    required: true,
    minlength: 22,
    maxlength: 22,
    match: BASE64URL,
    select: false,
  })
  contactAuthTag!: string;
  @Prop({ type: String, required: true, maxlength: 2000 }) requestSummary!: string;
  @Prop({ type: String, enum: ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'closed'], default: 'new' })
  status!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    minlength: 43,
    maxlength: 43,
    match: BASE64URL,
  })
  dedupeDigest!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) attribution!: Record<string, string>;
  @Prop({ type: String, default: null, maxlength: 128 }) assigneeId!: string | null;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) notes!: Array<{
    actorId: string; body: string; createdAt: string;
  }>;
  @Prop({ type: Date, required: true, immutable: true }) consentedAt!: Date;
  @Prop({ type: Number, required: true, default: 1, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type MarketingLeadDocument = HydratedDocument<MarketingLeadRecord>;
export const MarketingLeadRecordSchema = SchemaFactory.createForClass(MarketingLeadRecord);
MarketingLeadRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
MarketingLeadRecordSchema.index({ tenantId: 1, dedupeDigest: 1, createdAt: -1 });
MarketingLeadRecordSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
MarketingLeadRecordSchema.pre('validate', function validateProtectedContact() {
  for (const [field, value, bytes] of [
    ['contactIv', this.contactIv, 12],
    ['contactAuthTag', this.contactAuthTag, 16],
    ['dedupeDigest', this.dedupeDigest, 32],
  ] as const) {
    if (!isCanonicalBase64url(value, bytes)) {
      this.invalidate(field, '营销线索保护字段编码或长度非法');
    }
  }
  if (
    typeof this.contactCiphertext !== 'string' ||
    !BASE64URL.test(this.contactCiphertext) ||
    Buffer.from(this.contactCiphertext, 'base64url').toString('base64url') !==
      this.contactCiphertext ||
    Buffer.from(this.contactCiphertext, 'base64url').length < 5 ||
    Buffer.from(this.contactCiphertext, 'base64url').length > 762
  ) {
    this.invalidate('contactCiphertext', '营销线索密文编码或长度非法');
  }
});

export type MarketingSideEffectKind = 'lead_notification' | 'scheduled_publish';
export type MarketingSideEffectStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'delivered'
  | 'cancelled'
  | 'dead';

/** 营销副作用 Outbox；只保存路由引用，禁止复制联系人和内容正文。 */
@Schema({
  collection: 'marketing_side_effect_outbox',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class MarketingSideEffectRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  eventId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;
  @Prop({
    type: String,
    enum: ['lead_notification', 'scheduled_publish'],
    required: true,
    immutable: true,
  })
  kind!: MarketingSideEffectKind;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  aggregateId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  aggregateVersion!: number;
  @Prop({ type: String, enum: ['email', 'feishu'], default: null, immutable: true })
  channel!: 'email' | 'feishu' | null;
  @Prop({ type: Date, required: true, immutable: true })
  dueAt!: Date;
  @Prop({
    type: String,
    enum: ['pending', 'dispatching', 'dispatched', 'delivered', 'cancelled', 'dead'],
    required: true,
    default: 'pending',
  })
  status!: MarketingSideEffectStatus;
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  attempts!: number;
  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;
  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 })
  lockedBy!: string | null;
  @Prop({ type: Date, default: null })
  dispatchedAt!: Date | null;
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  deliveryAttempts!: number;
  @Prop({ type: Date, default: null })
  completedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 })
  lastErrorCode!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type MarketingSideEffectDocument = HydratedDocument<MarketingSideEffectRecord>;
export const MarketingSideEffectRecordSchema =
  SchemaFactory.createForClass(MarketingSideEffectRecord);
MarketingSideEffectRecordSchema.index({ eventId: 1 }, { unique: true });
MarketingSideEffectRecordSchema.index(
  { tenantId: 1, kind: 1, aggregateId: 1, aggregateVersion: 1, channel: 1 },
  { unique: true },
);
MarketingSideEffectRecordSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
MarketingSideEffectRecordSchema.pre('validate', function validateRouting() {
  if (
    (this.kind === 'lead_notification' && this.channel === null) ||
    (this.kind === 'scheduled_publish' && this.channel !== null)
  ) {
    this.invalidate('channel', '营销副作用渠道与类型不匹配');
  }
});

function isCanonicalBase64url(value: unknown, expectedBytes: number): boolean {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === expectedBytes && decoded.toString('base64url') === value;
}

@Schema({ collection: 'marketing_media', timestamps: true, versionKey: false, id: false })
export class MarketingMediaRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) siteId!: string;
  @Prop({ type: String, required: true, maxlength: 180 }) fileName!: string;
  @Prop({ type: String, required: true, maxlength: 100 }) mimeType!: string;
  @Prop({ type: Number, required: true, min: 1, max: 20_971_520 }) sizeBytes!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 512 }) objectRef!: string;
  @Prop({ type: String, enum: ['uploading', 'scanning', 'ready', 'rejected'], required: true })
  status!: 'uploading' | 'scanning' | 'ready' | 'rejected';
  @Prop({ type: String, default: null, minlength: 43, maxlength: 43 }) checksum!: string | null;
  @Prop({ type: String, default: null, maxlength: 128 }) scanEvidenceId!: string | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) variants!: Record<string, string>;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) altText!: Record<string, string>;
  @Prop({ type: String, default: '', maxlength: 500 }) copyrightSource!: string;
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type MarketingMediaDocument = HydratedDocument<MarketingMediaRecord>;
export const MarketingMediaRecordSchema = SchemaFactory.createForClass(MarketingMediaRecord);
MarketingMediaRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
MarketingMediaRecordSchema.index({ tenantId: 1, siteId: 1, status: 1, createdAt: -1 });
MarketingMediaRecordSchema.index({ tenantId: 1, objectRef: 1 }, { unique: true });

@Schema({ collection: 'marketing_ai_generations', timestamps: true, versionKey: false, id: false })
export class MarketingAiGenerationRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) actorId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) contentId!: string;
  @Prop({ type: String, enum: ['translate', 'rewrite', 'outline', 'seo', 'alt_text'], required: true })
  action!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) modelId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) promptVersion!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true, immutable: true }) output!: Record<string, unknown>;
  @Prop({ type: String, enum: ['pending_review', 'accepted', 'rejected'], default: 'pending_review' })
  status!: 'pending_review' | 'accepted' | 'rejected';
  createdAt!: Date;
  updatedAt!: Date;
}
export type MarketingAiGenerationDocument = HydratedDocument<MarketingAiGenerationRecord>;
export const MarketingAiGenerationRecordSchema =
  SchemaFactory.createForClass(MarketingAiGenerationRecord);
MarketingAiGenerationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
MarketingAiGenerationRecordSchema.index({ tenantId: 1, contentId: 1, createdAt: -1 });
