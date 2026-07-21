import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ESignFlowStatus =
  | 'awaiting_signature'
  | 'partial_signed'
  | 'provider_completed'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/** eSign 签署流程映射；外部流程 ID 加密保存，摘要只用于精确关联。 */
@Schema({ collection: 'integration_esign_flows', timestamps: true, versionKey: false, id: false })
export class ESignFlowRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['esign_cn'], required: true, immutable: true })
  provider!: 'esign_cn';

  @Prop({ type: String, required: true, immutable: true, minlength: 4, maxlength: 128 })
  appId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  offerId!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43, match: BASE64URL_PATTERN })
  externalFlowIdHash!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  externalIdKeyId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: BASE64URL_PATTERN })
  externalIdIv!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 1_024, match: BASE64URL_PATTERN })
  externalIdCiphertext!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  externalIdAuthTag!: string;

  @Prop({
    type: String,
    enum: [
      'awaiting_signature', 'partial_signed', 'provider_completed', 'completed',
      'rejected', 'expired', 'cancelled',
    ],
    required: true,
  })
  status!: ESignFlowStatus;

  @Prop({ type: Number, default: null, min: 0, max: 99 })
  providerStatus!: number | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  lastProviderAction!: string | null;

  @Prop({ type: Date, default: null })
  providerOccurredAt!: Date | null;

  @Prop({ type: Boolean, required: true, default: false })
  reviewRequired!: boolean;

  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]+$/ })
  reviewCode!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  signedEvidenceId!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ESignFlowDocument = HydratedDocument<ESignFlowRecord>;
export const ESignFlowRecordSchema = SchemaFactory.createForClass(ESignFlowRecord);

ESignFlowRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ESignFlowRecordSchema.index({ tenantId: 1, offerId: 1 }, { unique: true });
ESignFlowRecordSchema.index(
  { tenantId: 1, provider: 1, appId: 1, externalFlowIdHash: 1 }, { unique: true },
);
ESignFlowRecordSchema.index({ tenantId: 1, status: 1, updatedAt: 1 });
