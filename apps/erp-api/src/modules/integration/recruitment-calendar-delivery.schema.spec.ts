import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  RecruitmentCalendarDeliveryRecordSchema,
  type RecruitmentCalendarDeliveryRecord,
} from './recruitment-calendar-delivery.schema.js';

const mongoose = new Mongoose();
const DeliveryModel = mongoose.model<RecruitmentCalendarDeliveryRecord>(
  'SpecRecruitmentCalendarDelivery', RecruitmentCalendarDeliveryRecordSchema,
);

describe('RecruitmentCalendarDeliveryRecordSchema', () => {
  it('只保存投递标识与状态，不定义地点、参与人或凭据', async () => {
    await new DeliveryModel({
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4X0', tenantId: 'tenant-001',
      channel: 'feishu', interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
      externalCalendarId: 'recruitment-calendar',
      interviewVersion: 1, action: 'upsert', status: 'pending', attempts: 0,
      nextAttemptAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate();
    for (const field of [
      'location', 'interviewerIds', 'attendeeExternalIds', 'token', 'credential',
    ]) expect(RecruitmentCalendarDeliveryRecordSchema.path(field)).toBeUndefined();
  });

  it('全部业务索引以租户开头，Worker 队列索引例外', () => {
    const indexes = RecruitmentCalendarDeliveryRecordSchema.indexes();
    expect(indexes[0]?.[0]).toMatchObject({
      tenantId: 1, eventId: 1, channel: 1, externalCalendarId: 1,
    });
    expect(indexes[2]?.[0]).toMatchObject({ tenantId: 1, interviewId: 1, channel: 1 });
  });
});
