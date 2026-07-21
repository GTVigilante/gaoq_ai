import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import { ERP_AUTHORIZATION_SCOPE_PATTERN } from './authorization-scope.js';

/** 授权权限快照状态：active 生效中，disabled 已停用。 */
export const ACCESS_PROFILE_STATUSES = ['active', 'disabled'] as const;
export type AccessProfileStatus = (typeof ACCESS_PROFILE_STATUSES)[number];

/** 数组元素统一约束：非空字符串，最长 128。 */
const STRING_ARRAY_ELEMENT = {
  type: String,
  trim: true,
  minlength: 1,
  maxlength: 128,
} as const;

/** 构造数组最大长度校验器。 */
const maxLengthValidator = (max: number) => ({
  validator: (values: string[]) => values.length <= max,
  message: `数组长度不能超过 ${max}`,
});

/**
 * ERP 授权权限快照：记录租户内某个 actor 当前生效的角色、数据范围与部门授权，
 * 作为鉴权决策的只读快照。所有查询必须携带 tenantId。
 */
@Schema({ collection: 'identity_access_profiles', timestamps: true, versionKey: false })
export class AccessProfile {
  /** 本系统租户标识，所有查询必须携带。 */
  @Prop({ type: String, required: true, immutable: true, index: true })
  tenantId!: string;

  /** 租户内操作主体标识。 */
  @Prop({ type: String, required: true, immutable: true })
  actorId!: string;

  /** 关联的员工标识。 */
  @Prop({ type: String, required: true, immutable: true })
  employeeId!: string;

  /** 快照状态，仅 active 参与鉴权。 */
  @Prop({ type: String, enum: ACCESS_PROFILE_STATUSES, required: true, default: 'active' })
  status!: AccessProfileStatus;

  /** 角色编码集合，最多 100 个。 */
  @Prop({
    type: [STRING_ARRAY_ELEMENT],
    required: true,
    default: [],
    validate: maxLengthValidator(100),
  })
  roleCodes!: string[];

  /** 数据范围标识集合，最多 200 个。 */
  @Prop({
    type: [{ ...STRING_ARRAY_ELEMENT, match: ERP_AUTHORIZATION_SCOPE_PATTERN }],
    required: true,
    default: [],
    validate: maxLengthValidator(200),
  })
  scopes!: string[];

  /** 授权部门标识集合，最多 500 个。 */
  @Prop({
    type: [STRING_ARRAY_ELEMENT],
    required: true,
    default: [],
    validate: maxLengthValidator(500),
  })
  departmentIds!: string[];

  /** 乐观锁版本号，正整数，每次变更 +1。 */
  @Prop({
    type: Number,
    required: true,
    default: 1,
    min: 1,
    validate: { validator: Number.isInteger, message: 'version 必须为整数' },
  })
  version!: number;

  /** 创建时间，由 timestamps 自动维护。 */
  createdAt!: Date;

  /** 更新时间，由 timestamps 自动维护。 */
  updatedAt!: Date;
}

export type AccessProfileDocument = HydratedDocument<AccessProfile>;
export const AccessProfileSchema = SchemaFactory.createForClass(AccessProfile);

// 唯一性约束均带 tenantId 前缀，保证多租户隔离。
AccessProfileSchema.index({ tenantId: 1, actorId: 1 }, { unique: true });
AccessProfileSchema.index({ tenantId: 1, employeeId: 1 }, { unique: true });
