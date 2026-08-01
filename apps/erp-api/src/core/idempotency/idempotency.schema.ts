import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** 标识类字符串最大长度。 */
const MAX_ID_LENGTH = 128;
/** 幂等记录 TTL：24 小时。 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 幂等记录状态。 */
export type IdempotencyStatus = 'processing' | 'completed';

/**
 * 全局写接口幂等记录（集合 api_idempotency_records）。
 * 唯一性：tenantId+operation+idempotencyKey；expiresAt 为 TTL 锚点，到期自动清除。
 * 安全红线：response 严禁包含 token/secret/password/authorization 等敏感键（由服务层扫描兜底）。
 */
@Schema({
  collection: 'api_idempotency_records',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class IdempotencyRecord {
  /** 租户标识，来自已验证身份上下文，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  /** 业务操作标识（白名单字符集），创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  operation!: string;

  /** 客户端幂等键（白名单字符集，8..128 位），创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  idempotencyKey!: string;

  /** 请求体稳定规范 JSON 的 SHA-256（base64url），用于同键不同请求检测，创建后不可变。 */
  @Prop({ type: String, required: true, immutable: true })
  requestHash!: string;

  /** 执行状态：processing 处理中 / completed 已完成。 */
  @Prop({
    type: String,
    enum: ['processing', 'completed'],
    required: true,
    default: 'processing',
  })
  status!: IdempotencyStatus;

  /** 已完成时的纯 JSON 响应快照（Mixed）；未完成或执行中为 null。 */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  response!: Record<string, unknown> | null;

  /** TTL 锚点：创建后 24 小时过期，由 expireAfterSeconds=0 索引清除。 */
  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type IdempotencyRecordDocument = HydratedDocument<IdempotencyRecord>;
export const IdempotencyRecordSchema = SchemaFactory.createForClass(IdempotencyRecord);

/** 同一租户同一操作同一幂等键只允许一条记录（幂等核心约束）。 */
IdempotencyRecordSchema.index(
  { tenantId: 1, operation: 1, idempotencyKey: 1 },
  { unique: true },
);
/** expiresAt 到期即清除（TTL 24h，由服务层写入锚点时间）。 */
IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
