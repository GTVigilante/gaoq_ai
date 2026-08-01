import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

/** 租户与 e签宝应用绑定；只保存 Secret 引用，不保存 appSecret。 */
@Schema({ collection: 'integration_esign_bindings', timestamps: true, versionKey: false, id: false })
export class ESignBinding {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['esign_cn'], required: true, immutable: true })
  provider!: 'esign_cn';

  @Prop({ type: String, required: true, immutable: true, minlength: 4, maxlength: 128, match: /^[A-Za-z0-9_-]+$/ })
  appId!: string;

  @Prop({
    type: String, required: true, immutable: true,
    match: /^GAOQ_ESIGN_APP_[A-Z0-9_]{1,96}$/,
  })
  credentialSecretRef!: string;

  @Prop({ type: String, enum: ['active', 'disabled'], required: true })
  status!: 'active' | 'disabled';

  createdAt!: Date;
  updatedAt!: Date;
}

export type ESignBindingDocument = HydratedDocument<ESignBinding>;
export const ESignBindingSchema = SchemaFactory.createForClass(ESignBinding);

ESignBindingSchema.index({ tenantId: 1, provider: 1 }, { unique: true });
ESignBindingSchema.index({ tenantId: 1, appId: 1 }, { unique: true });
ESignBindingSchema.index({ provider: 1, appId: 1 }, { unique: true });
