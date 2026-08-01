import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { RecruitmentCalendarChannel } from './recruitment-calendar.adapter.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALENDAR_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;

/** 招聘日历绑定；凭据仍由组织平台绑定统一管理，这里只固定可写日历。 */
@Schema({
  collection: 'integration_recruitment_calendar_bindings',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentCalendarBinding {
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
    maxlength: 256,
    match: CALENDAR_ID_PATTERN,
  })
  externalCalendarId!: string;

  @Prop({ type: String, enum: ['active', 'disabled'], required: true, default: 'active' })
  status!: 'active' | 'disabled';

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentCalendarBindingDocument = HydratedDocument<RecruitmentCalendarBinding>;
export const RecruitmentCalendarBindingSchema = SchemaFactory.createForClass(
  RecruitmentCalendarBinding,
);

RecruitmentCalendarBindingSchema.index({ tenantId: 1, channel: 1 }, { unique: true });
