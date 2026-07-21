import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** 标识类字符串最大长度。 */
const MAX_ID_LENGTH = 128;
/** Outbox 已投递事件 TTL：30 天。 */
const DISPATCHED_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 禁止写入 envelope 的敏感键名（上游 token、密钥、原始敏感报文）。 */
const FORBIDDEN_ENVELOPE_KEY =
  /token|secret|password|credential|authorization|idcard|bankcard/i;
/** envelope 敏感键递归扫描的最大深度，防止深层构造拖垮校验。 */
const MAX_SCAN_DEPTH = 6;

/** Outbox 事件投递状态。 */
export type OutboxStatus = 'pending' | 'dispatching' | 'dispatched' | 'dead';

/**
 * 递归扫描对象键名，命中敏感键（token/secret/证件/银行卡等）返回 true。
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

/**
 * 集成 Outbox 持久化记录（集合 integration_outbox）。
 * 用途：领域事件可靠外发的存储转发；relay 按 status+nextAttemptAt 轮询。
 * 安全红线：envelope 严禁写入上游 token、密钥或原始敏感报文，
 * 仅允许存放脱敏后的领域事件负载（由 pre-validate 键名扫描兜底）。
 */
@Schema({ collection: 'integration_outbox', timestamps: true, versionKey: false, id: false })
export class OutboxRecord {
  /** 事件标识，ULID 形态字符串，全局唯一，创建后不可变。 */
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

  /** 聚合类型（如 org.department）。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateType!: string;

  /** 聚合标识。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateId!: string;

  /** 事件对应的聚合版本号。 */
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: {
      validator: (value: number): boolean => Number.isInteger(value) && value >= 1,
      message: 'aggregateVersion 必须为 >=1 的整数',
    },
  })
  aggregateVersion!: number;

  /** 事件类型（如 org.department.created）。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  eventType!: string;

  /**
   * 脱敏后的事件信封（Mixed）。
   * 禁止包含上游 token、密钥、原始敏感报文，键名命中黑名单即校验失败。
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

  /** 投递状态。 */
  @Prop({
    type: String,
    enum: ['pending', 'dispatching', 'dispatched', 'dead'],
    required: true,
    default: 'pending',
  })
  status!: OutboxStatus;

  /** 已尝试投递次数，非负整数。 */
  @Prop({
    type: Number,
    required: true,
    default: 0,
    validate: {
      validator: (value: number): boolean => Number.isInteger(value) && value >= 0,
      message: 'attempts 必须为非负整数',
    },
  })
  attempts!: number;

  /** 下一次可投递时间，relay 轮询依据。 */
  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  /** relay 抢占锁定时间；未锁定为 null。 */
  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  /** relay 抢占者标识；未锁定为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lockedBy!: string | null;

  /** 投递成功时间；同时作为 TTL 锚点（仅 dispatched 状态 30 天后清除）。 */
  @Prop({ type: Date, default: null })
  dispatchedAt!: Date | null;

  /** 最近一次失败的错误码；无失败为 null。 */
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  lastErrorCode!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OutboxDocument = HydratedDocument<OutboxRecord>;
export const OutboxRecordSchema = SchemaFactory.createForClass(OutboxRecord);

/** eventId 全局唯一。 */
OutboxRecordSchema.index({ eventId: 1 }, { unique: true });
/** 同一聚合同一版本同一事件类型只外发一次（租户内幂等）。 */
OutboxRecordSchema.index(
  { tenantId: 1, aggregateType: 1, aggregateId: 1, aggregateVersion: 1, eventType: 1 },
  { unique: true },
);
/** relay 轮询：按状态与到期时间扫描待投递事件。 */
OutboxRecordSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
/** 已投递事件 30 天后自动清除，仅作用于 status=dispatched 的文档。 */
OutboxRecordSchema.index(
  { dispatchedAt: 1 },
  {
    expireAfterSeconds: DISPATCHED_TTL_SECONDS,
    partialFilterExpression: { status: 'dispatched' },
  },
);
