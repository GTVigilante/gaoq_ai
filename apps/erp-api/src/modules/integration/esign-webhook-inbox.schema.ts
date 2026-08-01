import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** eSign Webhook 加密 Inbox；原始回调正文只保存 AES-GCM 密文。 */
@Schema({ collection: 'integration_esign_webhook_inbox', timestamps: true, versionKey: false, id: false })
export class ESignWebhookInboxRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['esign_cn'], required: true, immutable: true })
  provider!: 'esign_cn';

  @Prop({ type: String, required: true, immutable: true, minlength: 4, maxlength: 128 })
  appId!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL_PATTERN })
  providerEventId!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 1, maxlength: 128 })
  action!: string;

  @Prop({ type: Date, required: true, immutable: true })
  providerOccurredAt!: Date;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  payloadKeyId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  payloadIv!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 1_500_000, match: BASE64URL_PATTERN })
  payloadCiphertext!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  payloadAuthTag!: string;

  @Prop({
    type: String, enum: ['pending', 'processing', 'completed', 'ignored', 'failed'],
    required: true,
  })
  status!: 'pending' | 'processing' | 'completed' | 'ignored' | 'failed';

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  attempts!: number;

  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  failureCode!: string | null;

  @Prop({ type: Date, default: null })
  processedAt!: Date | null;

  @Prop({ type: Date, default: null })
  processingStartedAt!: Date | null;

  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  processingToken!: string | null;

  @Prop({ type: String, default: null, minlength: 1, maxlength: 128 })
  processingJobId!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ESignWebhookInboxDocument = HydratedDocument<ESignWebhookInboxRecord>;
export const ESignWebhookInboxRecordSchema = SchemaFactory.createForClass(ESignWebhookInboxRecord);

ESignWebhookInboxRecordSchema.pre('validate', function () {
  const record = this as ESignWebhookInboxRecord;
  const processing = record.status === 'processing';
  if (
    processing !== (record.processingStartedAt != null) ||
    processing !== (record.processingToken != null) ||
    processing !== (record.processingJobId != null)
  ) {
    throw new Error('eSign Inbox 处理状态与租约字段不一致');
  }
});

ESignWebhookInboxRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ESignWebhookInboxRecordSchema.index(
  { tenantId: 1, provider: 1, appId: 1, providerEventId: 1 }, { unique: true },
);
ESignWebhookInboxRecordSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
ESignWebhookInboxRecordSchema.index({ tenantId: 1, providerOccurredAt: 1 });
