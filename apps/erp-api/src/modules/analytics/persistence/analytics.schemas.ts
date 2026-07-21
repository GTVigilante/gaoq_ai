import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

export type AnalyticsExportStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** 管理分析异步导出；仅保存固定聚合 JSON，不保存个人明细。 */
@Schema({ collection: 'analytics_management_exports', timestamps: true, versionKey: false, id: false })
export class AnalyticsManagementExportRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) requestedBy!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ }) asOf!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['json'] }) format!: 'json';
  @Prop({ type: String, required: true, enum: ['queued', 'processing', 'ready', 'failed'] })
  status!: AnalyticsExportStatus;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 }) resourceUri!: string;
  @Prop({ type: String, default: null, maxlength: 65_536 }) artifactJson!: string | null;
  @Prop({ type: String, default: null, minlength: 43, maxlength: 43 }) contentHash!: string | null;
  @Prop({ type: String, default: null, maxlength: 96 }) failureCode!: string | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
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
  if (record.status === 'ready' && (record.artifactJson === null || record.contentHash === null)) {
    throw new Error('就绪分析导出必须包含产物和摘要');
  }
  if (record.status !== 'ready' && record.artifactJson !== null) {
    throw new Error('未就绪分析导出不能包含产物');
  }
  if (record.status === 'processing' && record.processingStartedAt === null) {
    throw new Error('处理中分析导出必须包含执行租约');
  }
  if (record.status !== 'processing' && record.processingStartedAt !== null) {
    throw new Error('非处理中分析导出不能持有执行租约');
  }
});
AnalyticsManagementExportRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AnalyticsManagementExportRecordSchema.index({ tenantId: 1, requestedBy: 1, createdAt: -1 });
AnalyticsManagementExportRecordSchema.index({ status: 1, processingStartedAt: 1 });
AnalyticsManagementExportRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
