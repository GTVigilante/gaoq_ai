import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { SsoProviderCode } from './auth.types.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LOGIN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

@Schema({ collection: 'identity_sso_tenant_bindings', timestamps: true, versionKey: false })
export class SsoTenantBinding {
  @Prop({ type: String, required: true, immutable: true, index: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;

  @Prop({
    type: String, required: true, immutable: true, minlength: 2, maxlength: 64,
    match: LOGIN_SLUG_PATTERN,
  })
  loginSlug!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu', 'op'], required: true, immutable: true })
  provider!: SsoProviderCode;

  @Prop({
    type: String, required: true, immutable: true, maxlength: 256,
    match: EXTERNAL_ID_PATTERN,
  })
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
