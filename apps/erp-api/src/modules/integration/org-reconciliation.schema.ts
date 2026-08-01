import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { OrgDeliveryAggregateType, OrgDeliveryChannel } from './org-delivery.schemas.js';

export type OrgReconciliationDifferenceKind =
  | 'mapping_missing'
  | 'external_missing'
  | 'external_orphan'
  | 'field_mismatch';

export interface OrgReconciliationDifference {
  readonly kind: OrgReconciliationDifferenceKind;
  readonly aggregateType: OrgDeliveryAggregateType;
  readonly aggregateId: string;
  readonly externalId?: string;
  readonly fields?: readonly string[];
}

/** 每日组织对账报告，只保存对象 ID 与差异字段名，不保存外部个人资料或原始响应。 */
@Schema({
  collection: 'integration_org_reconciliation_reports',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class OrgReconciliationReport {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu', 'op'], required: true, immutable: true })
  channel!: OrgDeliveryChannel;

  /** UTC 自然日 YYYY-MM-DD。 */
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  runDate!: string;

  @Prop({ type: String, enum: ['running', 'completed', 'failed'], required: true })
  status!: 'running' | 'completed' | 'failed';

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  expectedCount!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  externalCount!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  differenceCount!: number;

  @Prop({
    type: [{
      _id: false,
      kind: { type: String, enum: ['mapping_missing', 'external_missing', 'external_orphan', 'field_mismatch'], required: true },
      aggregateType: { type: String, enum: ['org.department', 'org.employee'], required: true },
      aggregateId: { type: String, required: true, maxlength: 128 },
      externalId: { type: String, maxlength: 128 },
      fields: [{ type: String, maxlength: 64 }],
    }],
    required: true,
    default: [],
  })
  differences!: OrgReconciliationDifference[];

  @Prop({ type: Boolean, required: true, default: false })
  truncated!: boolean;

  @Prop({ type: String, default: null, maxlength: 128 })
  lastErrorCode!: string | null;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrgReconciliationReportDocument = HydratedDocument<OrgReconciliationReport>;
export const OrgReconciliationReportSchema = SchemaFactory.createForClass(OrgReconciliationReport);

OrgReconciliationReportSchema.index({ tenantId: 1, channel: 1, runDate: 1 }, { unique: true });
OrgReconciliationReportSchema.index({ runDate: 1, status: 1 });
