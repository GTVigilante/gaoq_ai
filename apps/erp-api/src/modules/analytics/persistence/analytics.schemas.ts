import { createHash } from 'node:crypto';

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import { analyticsExportArtifactSchema } from '../analytics.contract.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,95}$/;
const MAX_ARTIFACT_BYTES = 65_536;

export type AnalyticsExportStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** 管理分析异步导出；仅保存固定聚合 JSON，不保存个人明细。 */
@Schema({ collection: 'analytics_management_exports', timestamps: true, versionKey: false, id: false })
export class AnalyticsManagementExportRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID })
  requestedBy!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ }) asOf!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['json'] }) format!: 'json';
  @Prop({ type: Number, required: true, min: 1 })
  generation!: number;
  @Prop({ type: String, required: true, enum: ['queued', 'processing', 'ready', 'failed'] })
  status!: AnalyticsExportStatus;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 }) resourceUri!: string;
  @Prop({ type: String, default: null, maxlength: 65_536 }) artifactJson!: string | null;
  @Prop({ type: String, default: null, minlength: 43, maxlength: 43, match: BASE64URL_43 })
  contentHash!: string | null;
  @Prop({ type: String, default: null, maxlength: 96, match: FAILURE_CODE })
  failureCode!: string | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128, match: ID })
  processingJobId!: string | null;
  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: /^[A-Za-z0-9_-]{22}$/ })
  processingToken!: string | null;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AnalyticsManagementExportDocument = HydratedDocument<AnalyticsManagementExportRecord>;
export const AnalyticsManagementExportRecordSchema = SchemaFactory.createForClass(
  AnalyticsManagementExportRecord,
);

AnalyticsManagementExportRecordSchema.pre('validate', function () {
  const record = this as AnalyticsManagementExportRecord;
  if (record.resourceUri !== `erp://analytics/exports/${record.id}`) {
    throw new Error('分析导出资源 URI 与导出标识不一致');
  }
  if (record.status === 'ready' && (record.artifactJson === null || record.contentHash === null)) {
    throw new Error('就绪分析导出必须包含产物和摘要');
  }
  if (
    record.status !== 'ready' &&
    (record.artifactJson !== null || record.contentHash !== null)
  ) {
    throw new Error('未就绪分析导出不能包含产物或摘要');
  }
  if (record.artifactJson !== null) {
    if (Buffer.byteLength(record.artifactJson, 'utf8') > MAX_ARTIFACT_BYTES) {
      throw new Error('分析导出产物超过大小上限');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.artifactJson) as unknown;
    } catch {
      throw new Error('分析导出产物不是有效 JSON');
    }
    if (!analyticsExportArtifactSchema.safeParse(parsed).success) {
      throw new Error('分析导出产物不符合固定契约');
    }
    const actualHash = createHash('sha256').update(record.artifactJson, 'utf8').digest('base64url');
    if (actualHash !== record.contentHash) throw new Error('分析导出内容摘要不匹配');
  }
  if (
    record.status === 'processing' &&
    (
      record.processingStartedAt === null ||
      record.processingJobId === null ||
      record.processingToken === null
    )
  ) {
    throw new Error('处理中分析导出必须包含完整执行租约');
  }
  if (
    record.status !== 'processing' &&
    (
      record.processingStartedAt !== null ||
      record.processingJobId !== null ||
      record.processingToken !== null
    )
  ) {
    throw new Error('非处理中分析导出不能持有执行租约');
  }
  if (record.status === 'failed' && record.failureCode === null) {
    throw new Error('失败分析导出必须包含失败码');
  }
  if (record.status !== 'failed' && record.failureCode !== null) {
    throw new Error('非失败分析导出不能包含失败码');
  }
});
AnalyticsManagementExportRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AnalyticsManagementExportRecordSchema.index({ tenantId: 1, requestedBy: 1, createdAt: -1 });
AnalyticsManagementExportRecordSchema.index({ status: 1, processingStartedAt: 1 });
AnalyticsManagementExportRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
