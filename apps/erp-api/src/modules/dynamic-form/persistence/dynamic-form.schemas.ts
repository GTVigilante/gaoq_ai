import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { DynamicFormItem } from '../domain/dynamic-form.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const positive = (value: number) => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;

@Schema({ collection: 'dynamic_form_definitions', timestamps: true, versionKey: false, id: false })
export class DynamicFormDefinitionRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: CODE }) code!: string;
  @Prop({ type: String, required: true, minlength: 2, maxlength: 128 }) name!: string;
  @Prop({ type: String, required: true, maxlength: 500 }) description!: string;
  @Prop({ type: [Object], required: true, validate: { validator: (value: unknown[]) => value.length >= 1 && value.length <= 200 } }) items!: DynamicFormItem[];
  @Prop({ type: Object, default: null }) workflow!: Record<string, unknown> | null;
  @Prop({ type: String, required: true, enum: ['draft', 'published', 'retired'] }) status!: 'draft' | 'published' | 'retired';
  @Prop({ type: Number, required: true, validate: { validator: positive } }) revision!: number;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) createdByActorId!: string;
  @Prop({ type: Date, default: null }) publishedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DynamicFormDefinitionDocument = HydratedDocument<DynamicFormDefinitionRecord>;
export const DynamicFormDefinitionRecordSchema = SchemaFactory.createForClass(DynamicFormDefinitionRecord);
DynamicFormDefinitionRecordSchema.pre('validate', function validateDefinitionState() {
  const published = this.status !== 'draft';
  if (published !== (this.publishedAt !== null)) this.invalidate('status', '表单发布状态与发布时间不一致');
});
DynamicFormDefinitionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
DynamicFormDefinitionRecordSchema.index({ tenantId: 1, code: 1, revision: 1 }, { unique: true });
DynamicFormDefinitionRecordSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });

@Schema({ collection: 'dynamic_form_records', timestamps: true, versionKey: false, id: false })
export class DynamicFormDataRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) formId!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } }) formRevision!: number;
  @Prop({ type: String, required: true, maxlength: 128, match: ID }) keyId!: string;
  @Prop({ type: String, required: true, minlength: 16, maxlength: 16, match: BASE64URL }) iv!: string;
  @Prop({ type: String, required: true, maxlength: 950_000, match: BASE64URL }) ciphertext!: string;
  @Prop({ type: String, required: true, minlength: 22, maxlength: 22, match: BASE64URL }) authTag!: string;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) createdByActorId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DynamicFormDataDocument = HydratedDocument<DynamicFormDataRecord>;
export const DynamicFormDataRecordSchema = SchemaFactory.createForClass(DynamicFormDataRecord);
DynamicFormDataRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
DynamicFormDataRecordSchema.index({ tenantId: 1, formId: 1, updatedAt: -1, id: 1 });

@Schema({ collection: 'dynamic_form_relations', timestamps: true, versionKey: false, id: false })
export class DynamicFormRelationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) sourceFormId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) sourceRecordId!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^[A-Za-z][A-Za-z0-9_]{0,63}$/ }) fieldKey!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) targetFormId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) targetRecordId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DynamicFormRelationDocument = HydratedDocument<DynamicFormRelationRecord>;
export const DynamicFormRelationRecordSchema = SchemaFactory.createForClass(DynamicFormRelationRecord);
DynamicFormRelationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
DynamicFormRelationRecordSchema.index({ tenantId: 1, sourceRecordId: 1, fieldKey: 1, targetRecordId: 1 }, { unique: true });
DynamicFormRelationRecordSchema.index({ tenantId: 1, targetRecordId: 1, sourceFormId: 1, fieldKey: 1 });
