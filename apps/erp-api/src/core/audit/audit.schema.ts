import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { RISK_LEVELS, type ActorType, type RiskLevel } from '@gaoq/shared-types';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9._:-]{2,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** 仅追加的持久审计事件；元数据以受控规范 JSON 字符串保存，禁止动态对象查询。 */
@Schema({
  collection: 'security_audit_events',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AuditEventRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  eventId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: isPositiveInteger, message: 'sequence 必须为正安全整数' },
  })
  sequence!: number;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  actorId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['user', 'service', 'mcp_client', 'system_job'],
  })
  actorType!: ActorType;

  @Prop({ type: String, required: true, immutable: true, match: ACTION_PATTERN })
  action!: string;

  @Prop({ type: String, required: true, immutable: true, match: ACTION_PATTERN })
  resourceType!: string;

  @Prop({ type: String, default: null, immutable: true, maxlength: 256 })
  resourceId!: string | null;

  @Prop({ type: String, required: true, immutable: true, enum: RISK_LEVELS })
  riskLevel!: RiskLevel;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['success', 'denied', 'failure'],
  })
  outcome!: 'success' | 'denied' | 'failure';

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  traceId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 4_096 })
  metadataCanonical!: string;

  @Prop({ type: String, required: true, immutable: true, match: KEY_ID_PATTERN })
  keyId!: string;

  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  previousHash!: string;

  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  eventHash!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AuditEventRecordDocument = HydratedDocument<AuditEventRecord>;
export const AuditEventRecordSchema = SchemaFactory.createForClass(AuditEventRecord);
AuditEventRecordSchema.index({ tenantId: 1, sequence: 1 }, { unique: true });
AuditEventRecordSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
AuditEventRecordSchema.index({ tenantId: 1, occurredAt: 1 });
AuditEventRecordSchema.index({ tenantId: 1, riskLevel: 1, occurredAt: 1 });
AuditEventRecordSchema.index({ tenantId: 1, actorId: 1, occurredAt: 1 });

/** 每租户审计链头；只允许原子追加服务在事务中推进。 */
@Schema({
  collection: 'security_audit_chain_heads',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AuditChainHeadRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  tenantId!: string;

  @Prop({
    type: Number,
    required: true,
    validate: { validator: isNonNegativeInteger, message: 'sequence 必须为非负安全整数' },
  })
  sequence!: number;

  @Prop({ type: String, required: true, match: HASH_PATTERN })
  eventHash!: string;

  @Prop({ type: String, required: true, match: KEY_ID_PATTERN })
  keyId!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AuditChainHeadRecordDocument = HydratedDocument<AuditChainHeadRecord>;
export const AuditChainHeadRecordSchema = SchemaFactory.createForClass(AuditChainHeadRecord);
AuditChainHeadRecordSchema.index({ tenantId: 1 }, { unique: true });
