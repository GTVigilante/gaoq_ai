import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** 外部身份提供方。 */
export const EXTERNAL_IDENTITY_PROVIDERS = ['dingtalk', 'feishu', 'op'] as const;
export type ExternalIdentityProvider = (typeof EXTERNAL_IDENTITY_PROVIDERS)[number];

/** 外部身份绑定状态：bound 已绑定可用，disabled 已解绑/停用。 */
export const EXTERNAL_IDENTITY_STATUSES = ['bound', 'disabled'] as const;
export type ExternalIdentityStatus = (typeof EXTERNAL_IDENTITY_STATUSES)[number];
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

/**
 * 外部身份映射：将钉钉/飞书/OP 等外部租户内的用户身份
 * 映射到本系统租户内的 actor（与员工）。
 * 只通过 unionId / externalUserId 精确匹配，禁止按手机号/邮箱自动合并。
 */
@Schema({ collection: 'identity_external_identities', timestamps: true, versionKey: false })
export class ExternalIdentity {
  /** 本系统租户标识，所有查询必须携带。 */
  @Prop({ type: String, required: true, immutable: true, index: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;

  /** 外部身份提供方。 */
  @Prop({ type: String, enum: EXTERNAL_IDENTITY_PROVIDERS, required: true, immutable: true })
  provider!: ExternalIdentityProvider;

  /** 外部平台侧的企业/组织标识（如钉钉 corpId、飞书 tenant_key）。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: 256, match: EXTERNAL_ID_PATTERN })
  externalTenantId!: string;

  /** 外部平台跨应用统一用户标识。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: 256, match: EXTERNAL_ID_PATTERN })
  unionId!: string;

  /** 外部平台企业内的用户标识。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: 256, match: EXTERNAL_ID_PATTERN })
  externalUserId!: string;

  /** 本系统租户内的操作主体标识。 */
  @Prop({ type: String, required: true, maxlength: 128, match: ID_PATTERN })
  actorId!: string;

  /** 本系统租户内的员工标识；人员 SSO 不允许绑定到服务主体。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;

  /** 绑定状态。 */
  @Prop({ type: String, enum: EXTERNAL_IDENTITY_STATUSES, required: true, default: 'bound' })
  status!: ExternalIdentityStatus;

  /** 创建时间，由 timestamps 自动维护。 */
  createdAt!: Date;

  /** 更新时间，由 timestamps 自动维护。 */
  updatedAt!: Date;
}

export type ExternalIdentityDocument = HydratedDocument<ExternalIdentity>;
export const ExternalIdentitySchema = SchemaFactory.createForClass(ExternalIdentity);

// 唯一性约束均带 tenantId 前缀，保证多租户隔离。
ExternalIdentitySchema.index(
  { tenantId: 1, provider: 1, externalTenantId: 1, unionId: 1 },
  { unique: true },
);
ExternalIdentitySchema.index(
  { tenantId: 1, provider: 1, externalTenantId: 1, externalUserId: 1 },
  { unique: true },
);
ExternalIdentitySchema.index({ tenantId: 1, provider: 1, employeeId: 1 }, { unique: true });
// 反查：租户内按 actor 查其外部身份绑定。
ExternalIdentitySchema.index({ tenantId: 1, actorId: 1 });
