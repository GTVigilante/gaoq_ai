import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

const MAX_ID_LENGTH = 128;

/** ERP 组织主数据在算薪侧的只读投影。 */
@Schema({
  collection: 'erp_master_data_projections',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class MasterDataProjectionRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({
    type: String,
    enum: ['department', 'employee', 'employment'],
    required: true,
    immutable: true,
  })
  kind!: 'department' | 'employee' | 'employment';

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateId!: string;

  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (value: number): boolean => Number.isInteger(value) && value >= 1,
      message: 'aggregateVersion 必须为正整数',
    },
  })
  aggregateVersion!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Date, required: true })
  sourceOccurredAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type MasterDataProjectionDocument =
  HydratedDocument<MasterDataProjectionRecord>;
export const MasterDataProjectionSchema =
  SchemaFactory.createForClass(MasterDataProjectionRecord);

MasterDataProjectionSchema.index(
  { tenantId: 1, kind: 1, aggregateId: 1 },
  { unique: true },
);
MasterDataProjectionSchema.index(
  { tenantId: 1, kind: 1, 'payload.status': 1, aggregateId: 1 },
);

/** ERP 主数据事件 Inbox，用于事务内幂等消费和审计。 */
@Schema({
  collection: 'erp_master_data_inbox',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class MasterDataInboxRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  eventId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  eventType!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 256 })
  idempotencyKey!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  aggregateId!: string;

  @Prop({ type: Number, required: true, immutable: true })
  aggregateVersion!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  traceId!: string;
}

export type MasterDataInboxDocument = HydratedDocument<MasterDataInboxRecord>;
export const MasterDataInboxSchema = SchemaFactory.createForClass(MasterDataInboxRecord);

MasterDataInboxSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
MasterDataInboxSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true },
);
