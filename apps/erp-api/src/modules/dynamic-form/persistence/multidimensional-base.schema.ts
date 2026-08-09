import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { MultidimensionalBaseInput } from '../domain/multidimensional-base.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

@Schema({ collection: 'multidimensional_bases', timestamps: true, versionKey: false, id: false })
export class MultidimensionalBaseRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: CODE }) code!: string;
  @Prop({ type: String, required: true, minlength: 2, maxlength: 128 }) name!: string;
  @Prop({ type: String, required: true, maxlength: 500 }) description!: string;
  @Prop({ type: [Object], required: true }) tables!: MultidimensionalBaseInput['tables'];
  @Prop({ type: [Object], required: true }) views!: MultidimensionalBaseInput['views'];
  @Prop({ type: [Object], required: true, default: [] }) automations!: MultidimensionalBaseInput['automations'];
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID }) createdByActorId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export type MultidimensionalBaseDocument = HydratedDocument<MultidimensionalBaseRecord>;
export const MultidimensionalBaseRecordSchema = SchemaFactory.createForClass(MultidimensionalBaseRecord);
MultidimensionalBaseRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
MultidimensionalBaseRecordSchema.index({ tenantId: 1, code: 1 }, { unique: true });
MultidimensionalBaseRecordSchema.index({ tenantId: 1, updatedAt: -1, id: 1 });
