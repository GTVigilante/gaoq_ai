import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { SsoProviderCode } from './auth.types.js';

@Schema({ collection: 'identity_sso_tenant_bindings', timestamps: true, versionKey: false })
export class SsoTenantBinding {
  @Prop({ type: String, required: true, immutable: true, index: true })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true })
  loginSlug!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  provider!: SsoProviderCode;

  @Prop({ type: String, required: true, immutable: true })
  externalTenantId!: string;

  @Prop({ type: String, enum: ['active', 'disabled'], required: true, default: 'active' })
  status!: 'active' | 'disabled';

  createdAt!: Date;
  updatedAt!: Date;
}

export type SsoTenantBindingDocument = HydratedDocument<SsoTenantBinding>;
export const SsoTenantBindingSchema = SchemaFactory.createForClass(SsoTenantBinding);

SsoTenantBindingSchema.index({ provider: 1, loginSlug: 1 }, { unique: true });
SsoTenantBindingSchema.index({ provider: 1, externalTenantId: 1 }, { unique: true });
SsoTenantBindingSchema.index({ tenantId: 1, provider: 1 }, { unique: true });
