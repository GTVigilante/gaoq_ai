import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  RecruitmentCalendarBindingSchema,
  type RecruitmentCalendarBinding,
} from './recruitment-calendar-binding.schema.js';

const mongoose = new Mongoose();
const BindingModel = mongoose.model<RecruitmentCalendarBinding>(
  'SpecRecruitmentCalendarBinding',
  RecruitmentCalendarBindingSchema,
);

describe('RecruitmentCalendarBindingSchema', () => {
  it('只保存日历标识，不保存平台凭据或 Token', async () => {
    await new BindingModel({
      tenantId: 'tenant-001',
      channel: 'feishu',
      externalCalendarId: 'feishu.cn_recruitment@group.calendar.feishu.cn',
      status: 'active',
    }).validate();
    expect(RecruitmentCalendarBindingSchema.path('credential')).toBeUndefined();
    expect(RecruitmentCalendarBindingSchema.path('token')).toBeUndefined();
    expect(RecruitmentCalendarBindingSchema.indexes()[0]?.[0]).toEqual({
      tenantId: 1,
      channel: 1,
    });
  });
});
