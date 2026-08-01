import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type { RecruitmentCalendarChannel } from './recruitment-calendar.adapter.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALENDAR_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const EXTERNAL_EVENT_ID_PATTERN = /^[\x21-\x7E]{1,512}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;

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

  @Prop({
    type: String,
    required: true,
    immutable: true,
    maxlength: 128,
    match: ID_PATTERN,
  })
  tenantId!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  channel!: RecruitmentCalendarChannel;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    maxlength: 256,
    match: CALENDAR_ID_PATTERN,
  })
  externalCalendarId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  interviewId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    min: 1,
    validate: {
      validator: (value: number) => Number.isSafeInteger(value),
      message: 'interviewVersion 必须为安全整数',
    },
  })
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

  @Prop({ type: Number, required: true, default: 0, min: 0, max: 8 })
  attempts!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  operatorResolutionCount!: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  lockedBy!: string | null;

  @Prop({
    type: String,
    default: null,
    maxlength: 512,
    match: EXTERNAL_EVENT_ID_PATTERN,
  })
  externalEventId!: string | null;

  @Prop({ type: String, default: null, maxlength: 128, match: ERROR_CODE_PATTERN })
  lastErrorCode!: string | null;

  @Prop({ type: String, enum: ['retryable', 'business', 'conflict', null], default: null })
  lastErrorCategory!: 'retryable' | 'business' | 'conflict' | null;

  @Prop({ type: Date, default: null })
  succeededAt!: Date | null;

  @Prop({ type: Date, default: null })
  operatorResolvedAt!: Date | null;

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
