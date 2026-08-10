import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { AutomationExecutionPlan } from '../domain/base-automation-interpreter.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

@Schema({ collection: 'base_automation_runs', timestamps: true, versionKey: false, id: false })
export class BaseAutomationRunRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) baseId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) baseVersion!: number;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) automationId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) automationName!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) sourceTableId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) sourceRecordId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) sourceRecordVersion!: number;
  @Prop({ type: String, required: true, immutable: true, enum: ['record_created', 'record_updated'] }) triggerType!: AutomationExecutionPlan['triggerType'];
  @Prop({ type: [Object], required: true, immutable: true }) actions!: AutomationExecutionPlan['actions'];
  @Prop({ type: String, required: true, immutable: true, match: HASH }) planHash!: string;
  @Prop({ type: String, required: true, enum: ['pending', 'processing', 'completed', 'manual_review'] }) status!: 'pending' | 'processing' | 'completed' | 'manual_review';
  @Prop({ type: Number, required: true, min: 0, default: 0 }) nextActionIndex!: number;
  @Prop({ type: [Object], required: true, default: [] }) actionResults!: readonly BaseAutomationActionResult[];
  @Prop({ type: String, default: null, maxlength: 128, validate: { validator: (value: unknown) => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/.test(value)) } }) failureCode!: string | null;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}

export interface BaseAutomationActionResult {
  readonly index: number;
  readonly type: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly version: number;
}

export type BaseAutomationRunDocument = HydratedDocument<BaseAutomationRunRecord>;
export const BaseAutomationRunRecordSchema = SchemaFactory.createForClass(BaseAutomationRunRecord);
BaseAutomationRunRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
BaseAutomationRunRecordSchema.index({ tenantId: 1, baseId: 1, automationId: 1, sourceRecordId: 1, sourceRecordVersion: 1, triggerType: 1 }, { unique: true });
BaseAutomationRunRecordSchema.index({ status: 1, updatedAt: 1, id: 1 });
