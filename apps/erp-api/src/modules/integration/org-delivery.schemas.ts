import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** 标识类字符串最大长度。 */
const MAX_ID_LENGTH = 128;
/** 下发成功记录 TTL：90 天。 */
const SUCCEEDED_TTL_SECONDS = 90 * 24 * 60 * 60;
/** 禁止写入 envelope 的敏感键名（上游 token、密钥、证件、银行卡、联系方式）。 */
const FORBIDDEN_ENVELOPE_KEY =
  /token|secret|password|credential|authorization|idcard|bankcard|mobile|phone|email/i;
/** envelope 敏感键递归扫描的最大深度，超过即失败关闭。 */
const MAX_SCAN_DEPTH = 6;

/** 组织下发渠道。 */
export type OrgDeliveryChannel = 'dingtalk' | 'feishu' | 'op';

/** 组织下发聚合类型。 */
export type OrgDeliveryAggregateType = 'org.department' | 'org.employee';

/** 组织下发状态。 */
export type OrgDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'dead'
  | 'manual_review';

/** 最近一次失败的错误分类。 */
export type OrgDeliveryErrorCategory = 'retryable' | 'business' | 'conflict';

/**
 * 递归扫描对象键名，命中敏感键返回 true；超过最大深度按命中处理（失败关闭）。
 * 只检查键名，不检查值，避免误伤业务正文。
 */
function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCAN_DEPTH) {
    return true;
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item, depth + 1));
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_ENVELOPE_KEY.test(key)) {
      return true;
    }
    if (containsForbiddenKey(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** 非负整数校验器。 */
const isNonNegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

/** 大于等于 1 的整数校验器。 */
const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 1;

/**
 * 组织下发持久化记录（集合 integration_org_deliveries）。
 * 用途：ERP 组织事件向钉钉/飞书/OP 下发的存储转发与重试轨迹。
 * 安全红线：envelope 严禁写入上游 token、密钥或含联系方式的原始报文，
 * 仅允许存放脱敏后的下发负载（由键名递归扫描兜底，递归过深失败关闭）。
 */
@Schema({
  collection: 'integration_org_deliveries',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class OrgDeliveryRecord {
  /** 事件标识，严格 ULID，创建后不可变；与 channel 联合唯一。 */
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: [ULID_PATTERN, 'eventId 必须为 ULID 形态（26 位 Crockford Base32）'],
  })
  eventId!: string;

  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 下发渠道，创建后不可变。 */
  @Prop({
    type: String,
    enum: ['dingtalk', 'feishu', 'op'],
    required: true,
    immutable: true,
  })
  channel!: OrgDeliveryChannel;

  /** 聚合类型，创建后不可变。 */
  @Prop({
    type: String,
    enum: ['org.department', 'org.employee'],
    required: true,
    immutable: true,
  })
  aggregateType!: OrgDeliveryAggregateType;

  /** 聚合标识，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateId!: string;

  /** 事件对应的聚合版本号，正整数，创建后不可变。 */
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: {
      validator: isPositiveInteger,
      message: 'aggregateVersion 必须为 >=1 的整数',
    },
  })
  aggregateVersion!: number;

  /** 事件类型（如 org.department.created），创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  eventType!: string;

  /**
   * 脱敏后的下发信封（Mixed）。
   * 禁止包含上游 token、密钥、证件、银行卡、联系方式字段，键名命中黑名单即校验失败。
   */
  @Prop({
    type: MongooseSchema.Types.Mixed,
    required: true,
    validate: {
      validator: (value: unknown): boolean => !containsForbiddenKey(value),
      message: 'envelope 禁止包含上游 token、密钥或原始敏感报文字段',
    },
  })
  envelope!: Record<string, unknown>;

  /** 下发状态。 */
  @Prop({
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'dead', 'manual_review'],
    required: true,
    default: 'pending',
  })
  status!: OrgDeliveryStatus;

  /** 已尝试下发次数，非负整数。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: { validator: isNonNegativeInteger, message: 'attempts 必须为非负整数' },
  })
  attempts!: number;

  /** 人工确认后重新投递次数；保留原始失败轨迹的独立计数。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: { validator: isNonNegativeInteger, message: 'operatorRetryCount 必须为非负整数' },
  })
  operatorRetryCount!: number;

  /** 下一次可下发时间，relay 轮询依据。 */
  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  /** relay 抢占锁定时间；未锁定为 null。 */
  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  /** relay 抢占者标识；未锁定为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lockedBy!: string | null;

  /** 外部系统返回的对象标识（钉钉 dept_id / 飞书 department_id 等）；未返回为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  externalId!: string | null;

  /** 最近一次失败的错误码；无失败为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lastErrorCode!: string | null;

  /** 最近一次失败的错误分类；无失败为 null。 */
  @Prop({ type: String, enum: ['retryable', 'business', 'conflict'], default: null })
  lastErrorCategory!: OrgDeliveryErrorCategory | null;

  /** 下发成功时间；同时作为 TTL 锚点（仅 succeeded 状态 90 天后清除）。 */
  @Prop({ type: Date, default: null })
  succeededAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgDeliveryDocument = HydratedDocument<OrgDeliveryRecord>;
export const OrgDeliveryRecordSchema = SchemaFactory.createForClass(OrgDeliveryRecord);

/** eventId+channel 唯一：同一事件在两个渠道各下发一次。 */
OrgDeliveryRecordSchema.index({ eventId: 1, channel: 1 }, { unique: true });
/** relay 轮询：按状态与到期时间扫描待下发记录。 */
OrgDeliveryRecordSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
/** 按租户/渠道/聚合/版本查询下发轨迹。 */
OrgDeliveryRecordSchema.index({
  tenantId: 1,
  channel: 1,
  aggregateType: 1,
  aggregateId: 1,
  aggregateVersion: 1,
});
/** 成功记录 90 天后自动清除，仅作用于 status=succeeded 的文档。 */
OrgDeliveryRecordSchema.index(
  { succeededAt: 1 },
  {
    expireAfterSeconds: SUCCEEDED_TTL_SECONDS,
    partialFilterExpression: { status: 'succeeded' },
  },
);

/**
 * 外部版本状态记录（集合 integration_org_external_versions）。
 * 用途：记录某租户某渠道下某聚合已应用的最高版本，
 * 配合唯一索引做原子条件更新，拒绝低版本与重复版本下发。
 */
@Schema({
  collection: 'integration_org_external_versions',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class OrgExternalVersionState {
  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 下发渠道，创建后不可变。 */
  @Prop({
    type: String,
    enum: ['dingtalk', 'feishu', 'op'],
    required: true,
    immutable: true,
  })
  channel!: OrgDeliveryChannel;

  /** 聚合类型，创建后不可变。 */
  @Prop({
    type: String,
    enum: ['org.department', 'org.employee'],
    required: true,
    immutable: true,
  })
  aggregateType!: OrgDeliveryAggregateType;

  /** 聚合标识，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateId!: string;

  /** 已应用的最高聚合版本，非负整数，从 0 开始。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: { validator: isNonNegativeInteger, message: 'appliedVersion 必须为非负整数' },
  })
  appliedVersion!: number;

  /** 外部系统对象标识；首次下发成功前为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  externalId!: string | null;

  /** 最近一次成功应用的事件标识；尚未成功为 null，非空时严格 ULID。 */
  @Prop({
    type: String,
    default: null,
    match: [ULID_PATTERN, 'lastEventId 必须为 ULID 形态（26 位 Crockford Base32）'],
  })
  lastEventId!: string | null;

  /** 当前已原子预留、正在外部调用的版本；空闲时为 null。 */
  @Prop({
    type: Number,
    default: null,
    validate: {
      validator: (value: number | null): boolean => value === null || isPositiveInteger(value),
      message: 'processingVersion 必须为正整数或 null',
    },
  })
  processingVersion!: number | null;

  /** 当前预留对应事件；空闲时为 null，非空时严格 ULID。 */
  @Prop({
    type: String,
    default: null,
    match: [ULID_PATTERN, 'processingEventId 必须为 ULID 形态（26 位 Crockford Base32）'],
  })
  processingEventId!: string | null;

  /** 版本预留租约，防 Worker 崩溃造成永久锁定。 */
  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lockedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgExternalVersionStateDocument = HydratedDocument<OrgExternalVersionState>;
export const OrgExternalVersionStateSchema =
  SchemaFactory.createForClass(OrgExternalVersionState);

/** 租户+渠道+聚合唯一：每聚合每渠道仅一条版本状态。 */
OrgExternalVersionStateSchema.index(
  { tenantId: 1, channel: 1, aggregateType: 1, aggregateId: 1 },
  { unique: true },
);
