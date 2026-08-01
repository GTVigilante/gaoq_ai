import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const MAX_ID = 128;
const MAX_SCOPE_IDS = 200;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const ERROR_CODE = /^[A-Z0-9_]{3,128}$/u;

export type KnowledgeSearchIndexOperation = 'upsert' | 'delete';
export type KnowledgeSearchIndexTaskStatus = 'pending' | 'processing' | 'completed' | 'dead';

/**
 * 搜索索引事务任务；正文留在内容域，只保存不可解释内容引用与授权投影。
 * MongoDB 是待执行事实源，Worker 只把最小投影发送给独立搜索网关。
 */
@Schema({
  collection: 'knowledge_search_index_tasks',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class KnowledgeSearchIndexTaskRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  eventId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  courseVersionId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64 })
  courseCode!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  revision!: number;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  courseVersion!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID })
  contentRef!: string;

  @Prop({ type: String, enum: ['upsert', 'delete'], required: true, immutable: true })
  operation!: KnowledgeSearchIndexOperation;

  @Prop({
    type: String,
    enum: ['assigned_only', 'employment_scope'],
    required: true,
    immutable: true,
  })
  audienceMode!: 'assigned_only' | 'employment_scope';

  @Prop({ type: [String], required: true, immutable: true, default: [] })
  audienceDepartmentIds!: string[];

  @Prop({ type: [String], required: true, immutable: true, default: [] })
  audiencePositionIds!: string[];

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'completed', 'dead'],
    required: true,
    default: 'pending',
  })
  status!: KnowledgeSearchIndexTaskStatus;

  @Prop({ type: Number, required: true, min: 0, max: 8, default: 0 })
  attempts!: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID, match: SAFE_ID })
  lockedBy!: string | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID, match: SAFE_ID })
  receiptId!: string | null;

  @Prop({ type: String, default: null, minlength: 43, maxlength: 43, match: DIGEST })
  indexedContentDigest!: string | null;

  @Prop({ type: Date, default: null })
  indexedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: MAX_ID, match: ERROR_CODE })
  lastErrorCode!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type KnowledgeSearchIndexTaskDocument =
  HydratedDocument<KnowledgeSearchIndexTaskRecord>;
export const KnowledgeSearchIndexTaskRecordSchema =
  SchemaFactory.createForClass(KnowledgeSearchIndexTaskRecord);

KnowledgeSearchIndexTaskRecordSchema.index(
  { tenantId: 1, eventId: 1 },
  { unique: true },
);
KnowledgeSearchIndexTaskRecordSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
);
KnowledgeSearchIndexTaskRecordSchema.index(
  { tenantId: 1, courseVersionId: 1, courseVersion: -1, createdAt: -1 },
);
KnowledgeSearchIndexTaskRecordSchema.index(
  { tenantId: 1, courseVersionId: 1, courseVersion: 1, operation: 1 },
  { unique: true },
);
KnowledgeSearchIndexTaskRecordSchema.pre('validate', function validateSearchTask() {
  if (
    !validIds(this.audienceDepartmentIds) ||
    !validIds(this.audiencePositionIds)
  ) throw new Error('知识搜索索引任务授权范围非法');
  if (
    (this.audienceMode === 'assigned_only' &&
      (this.audienceDepartmentIds.length > 0 || this.audiencePositionIds.length > 0)) ||
    (this.audienceMode === 'employment_scope' &&
      this.audienceDepartmentIds.length === 0 && this.audiencePositionIds.length === 0)
  ) throw new Error('知识搜索索引任务授权组合非法');
  const completionEvidence = [
    this.completedAt,
    this.receiptId,
    this.indexedContentDigest,
    this.indexedAt,
  ];
  if (
    this.status === 'completed'
      ? completionEvidence.some((value) => value === null)
      : completionEvidence.some((value) => value !== null)
  ) throw new Error('知识搜索索引任务完成证据组合非法');
  if (
    this.status === 'processing'
      ? this.lockedAt === null || this.lockedBy === null
      : this.lockedAt !== null || this.lockedBy !== null
  ) throw new Error('知识搜索索引任务锁组合非法');
});

function validIds(values: unknown): values is string[] {
  return Array.isArray(values) &&
    values.length <= MAX_SCOPE_IDS &&
    new Set(values).size === values.length &&
    values.every((value) => typeof value === 'string' && SAFE_ID.test(value));
}
