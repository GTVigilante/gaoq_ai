import { describe, expect, it } from 'vitest';

import {
  RecruitmentCalendarAdapter,
  RecruitmentCalendarAdapterRegistry,
  type RecruitmentCalendarChannel,
  type RecruitmentCalendarResult,
} from './recruitment-calendar.adapter.js';

class FakeCalendarAdapter extends RecruitmentCalendarAdapter {
  constructor(readonly channel: RecruitmentCalendarChannel) { super(); }

  upsert(): Promise<RecruitmentCalendarResult> {
    return Promise.resolve({ externalEventId: `${this.channel}-event` });
  }

  cancel(): Promise<RecruitmentCalendarResult> {
    return Promise.resolve({ externalEventId: `${this.channel}-event` });
  }
}

describe('RecruitmentCalendarAdapterRegistry', () => {
  it('同时装配钉钉和飞书标准适配器', () => {
    const registry = new RecruitmentCalendarAdapterRegistry(
      new FakeCalendarAdapter('dingtalk'), new FakeCalendarAdapter('feishu'),
    );
    expect(registry.get('dingtalk').channel).toBe('dingtalk');
    expect(registry.get('feishu').channel).toBe('feishu');
  });

  it('渠道装配错位时失败关闭', () => {
    expect(() => new RecruitmentCalendarAdapterRegistry(
      new FakeCalendarAdapter('feishu'), new FakeCalendarAdapter('dingtalk'),
    )).toThrow('日历适配器渠道装配错误');
  });
});
