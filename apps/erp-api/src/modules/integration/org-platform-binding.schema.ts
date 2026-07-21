import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { OrgDeliveryChannel } from './org-delivery.schemas.js';

const SECRET_REF_PATTERN = /^GAOQ_ORG_PLATFORM_[A-Z0-9_]{1,96}$/;

/**
 * 组织平台租户绑定。这里只保存 Secret Manager 注入变量的引用，绝不保存客户端密钥。
 */
@Schema({
  collection: 'integration_org_platform_bindings',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class OrgPlatformBinding {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  channel!: OrgDeliveryChannel;

  @Prop({ type: String, required: true, maxlength: 128 })
  externalTenantId!: string;

  @Prop({
    type: String,
    required: true,
    maxlength: 128,
    match: [SECRET_REF_PATTERN, 'credentialSecretRef 必须使用受控前缀'],
  })
  credentialSecretRef!: string;

  @Prop({ type: String, enum: ['active', 'disabled'], required: true, default: 'active' })
  status!: 'active' | 'disabled';

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgPlatformBindingDocument = HydratedDocument<OrgPlatformBinding>;
export const OrgPlatformBindingSchema = SchemaFactory.createForClass(OrgPlatformBinding);

OrgPlatformBindingSchema.index({ tenantId: 1, channel: 1 }, { unique: true });
OrgPlatformBindingSchema.index({ channel: 1, externalTenantId: 1 }, { unique: true });
