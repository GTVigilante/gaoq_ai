import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

/** 标识类字符串最大长度。 */
const MAX_ID_LENGTH = 128;
/** 员工标识：字母数字及 . _ : -，长度 1..128。 */
const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** 通用受控标识：与身份底座字符集保持一致。 */
const CONTROLLED_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** 幂等键使用全局 8..128 位白名单规范。 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
/** 错误码：大写字母开头，后续为大写字母数字下划线，长度 2..64。 */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
/** base64url 形态（SHA-256 摘要为 43 字符；密文/IV/认证标签为变长）。 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** SHA-256 摘要的 base64url 形态，固定 43 字符。 */
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 最大尝试次数上限（含首次），attempts 取值 0..6。 */
const MAX_ATTEMPTS = 6;

/** 私密通道开户请求状态。 */
export type OrgEmployeeProvisioningStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'manual_review'
  | 'expired';

/** attempts 校验器：0..MAX_ATTEMPTS 的整数。 */
const isValidAttempts = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= MAX_ATTEMPTS;

/**
 * 员工首次开户私密通道请求（集合 integration_org_employee_provisioning_requests）。
 * 用途：承载「联系方式私密传递给员工」的开户请求的存储转发、重试与审计轨迹。
 *
 * 安全红线：
 * - 本集合严禁出现任何手机号 / 邮箱等联系方式明文字段；
 * - 联系方式仅以加密密文（payloadCiphertext/payloadIv/payloadAuthTag）
 *   与不可逆摘要（inputDigest）形态存在；
 * - 密文字段允许置 null：进入终态（succeeded/expired）或超过
 *   sensitiveExpiresAt 后，服务层必须将密文字段擦除为 null；
 * - purgeAt 为 TTL 锚点，到期后整条记录由 MongoDB 自动清除。
 */
@Schema({
  collection: 'integration_org_employee_provisioning_requests',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class OrgEmployeeProvisioningRequest {
  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [CONTROLLED_ID_PATTERN, 'tenantId 标识非法'],
  })
  tenantId!: string;

  /** 请求标识，严格 ULID，创建后不可变。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [ULID_PATTERN, 'requestId 必须为 ULID 形态（26 位 Crockford Base32）'],
  })
  requestId!: string;

  /** ERP 侧员工标识，创建后不可变。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [EMPLOYEE_ID_PATTERN, 'employeeId 仅允许字母数字及 . _ : -，长度 1..128'],
  })
  employeeId!: string;

  /** 开户目标平台渠道，创建后不可变。 */
  @Prop({
    type: String,
    enum: ['dingtalk', 'feishu'],
    required: true,
    immutable: true,
  })
  channel!: 'dingtalk' | 'feishu';

  /** 发起请求的操作者标识（来自已验证身份），创建后不可变。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [CONTROLLED_ID_PATTERN, 'requestedByActorId 标识非法'],
  })
  requestedByActorId!: string;

  /** 幂等键，创建后不可变；与 tenantId+channel 联合唯一。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [IDEMPOTENCY_KEY_PATTERN, 'idempotencyKey 必须为 8..128 位白名单字符'],
  })
  idempotencyKey!: string;

  /**
   * 规范化输入的带密钥 HMAC-SHA-256 摘要（base64url 43 字符），创建后不可变。
   * 用于幂等比对与审计，不可反推明文联系方式。
   */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [DIGEST_PATTERN, 'inputDigest 必须为 SHA-256 的 base64url 形态（43 字符）'],
  })
  inputDigest!: string;

  /** 加密载荷使用的密钥标识（指向密钥管理系统），创建后不可变。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [CONTROLLED_ID_PATTERN, 'payloadKeyId 标识非法'],
  })
  payloadKeyId!: string;

  /** 加密载荷的初始化向量（base64url）；擦除后为 null。 */
  @Prop({
    type: String,
    default: null,
    minlength: 16,
    maxlength: 16,
    match: [BASE64URL_PATTERN, 'payloadIv 必须为 12 字节 base64url'],
  })
  payloadIv!: string | null;

  /** 联系方式加密密文（base64url）；终态或到期擦除后为 null。 */
  @Prop({
    type: String,
    default: null,
    maxlength: 1024,
    match: [BASE64URL_PATTERN, 'payloadCiphertext 必须为 base64url 形态'],
  })
  payloadCiphertext!: string | null;

  /** 加密载荷的认证标签（base64url，AEAD）；擦除后为 null。 */
  @Prop({
    type: String,
    default: null,
    minlength: 22,
    maxlength: 22,
    match: [BASE64URL_PATTERN, 'payloadAuthTag 必须为 16 字节 base64url'],
  })
  payloadAuthTag!: string | null;

  /** 请求状态。 */
  @Prop({
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'manual_review', 'expired'],
    required: true,
    default: 'pending',
  })
  status!: OrgEmployeeProvisioningStatus;

  /** 已尝试处理次数，整数，取值 0..6。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: { validator: isValidAttempts, message: 'attempts 必须为 0..6 的整数' },
  })
  attempts!: number;

  /** 下一次可处理时间，调度轮询依据。 */
  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  /** 处理抢占锁定时间；未锁定为 null。 */
  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  /** 处理抢占者标识；未锁定为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lockedBy!: string | null;

  /** 最近一次失败的错误码；无失败为 null。 */
  @Prop({
    type: String,
    default: null,
    match: [ERROR_CODE_PATTERN, 'lastErrorCode 必须为大写错误码形态（如 PROVISIONING_RETRYABLE）'],
  })
  lastErrorCode!: string | null;

  /** 平台侧用户标识（钉钉 userid / 飞书 user_id）；开户成功前为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  externalUserId!: string | null;

  /** 平台侧请求标识（用于对账）；未返回为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  platformRequestId!: string | null;

  /** 密文敏感数据到期时间；到期后服务层必须擦除密文字段。 */
  @Prop({ type: Date, required: true })
  sensitiveExpiresAt!: Date;

  /** 整条记录的 TTL 锚点，到期由 MongoDB 自动清除。 */
  @Prop({ type: Date, required: true })
  purgeAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgEmployeeProvisioningRequestDocument =
  HydratedDocument<OrgEmployeeProvisioningRequest>;
export const OrgEmployeeProvisioningRequestSchema = SchemaFactory.createForClass(
  OrgEmployeeProvisioningRequest,
);

/** 幂等：同租户同渠道下同一幂等键仅允许一条请求。 */
OrgEmployeeProvisioningRequestSchema.index(
  { tenantId: 1, channel: 1, idempotencyKey: 1 },
  { unique: true },
);
/** 调度轮询：按状态与到期时间扫描待处理请求。 */
OrgEmployeeProvisioningRequestSchema.index({ status: 1, nextAttemptAt: 1 });
/** 敏感数据到期扫描：驱动密文擦除任务。 */
OrgEmployeeProvisioningRequestSchema.index({ sensitiveExpiresAt: 1 });
/** TTL：purgeAt 到期后整条记录自动清除。 */
OrgEmployeeProvisioningRequestSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
