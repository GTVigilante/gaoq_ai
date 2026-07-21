import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { RecruitmentCalendarChannel } from './recruitment-calendar.adapter.js';

export type RecruitmentCalendarDeliveryAction = 'upsert' | 'cancel';
export type RecruitmentCalendarDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'dead'
  | 'manual_review';

/** 日历投递轨迹；不保存会议地点、参与人或平台凭据。 */
@Schema({
  collection: 'integration_recruitment_calendar_deliveries',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentCalendarDeliveryRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  eventId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  channel!: RecruitmentCalendarChannel;

  @Prop({ type: String, required: true, immutable: true, maxlength: 256 })
  externalCalendarId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  interviewId!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  interviewVersion!: number;

  @Prop({ type: String, enum: ['upsert', 'cancel'], required: true, immutable: true })
  action!: RecruitmentCalendarDeliveryAction;

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'succeeded', 'dead', 'manual_review'],
    required: true,
    default: 'pending',
  })
  status!: RecruitmentCalendarDeliveryStatus;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  attempts!: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  lockedBy!: string | null;

  @Prop({ type: String, default: null, maxlength: 512 })
  externalEventId!: string | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  lastErrorCode!: string | null;

  @Prop({ type: String, enum: ['retryable', 'business', 'conflict', null], default: null })
  lastErrorCategory!: 'retryable' | 'business' | 'conflict' | null;

  @Prop({ type: Date, default: null })
  succeededAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentCalendarDeliveryDocument = HydratedDocument<
  RecruitmentCalendarDeliveryRecord
>;
export const RecruitmentCalendarDeliveryRecordSchema = SchemaFactory.createForClass(
  RecruitmentCalendarDeliveryRecord,
);

RecruitmentCalendarDeliveryRecordSchema.index(
  { tenantId: 1, eventId: 1, channel: 1, externalCalendarId: 1 },
  { unique: true },
);
RecruitmentCalendarDeliveryRecordSchema.index(
  { status: 1, channel: 1, nextAttemptAt: 1, createdAt: 1 },
);
RecruitmentCalendarDeliveryRecordSchema.index(
  {
    tenantId: 1,
    interviewId: 1,
    channel: 1,
    externalCalendarId: 1,
    interviewVersion: 1,
  },
);
