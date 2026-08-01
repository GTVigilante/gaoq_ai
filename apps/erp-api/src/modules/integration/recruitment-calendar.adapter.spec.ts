import { describe, expect, it } from 'vitest';

import {
  RecruitmentCalendarAdapter,
  RecruitmentCalendarAdapterRegistry,
  RecruitmentCalendarError,
  assertCancelRecruitmentCalendarCommand,
  assertRecruitmentCalendarExternalEventId,
  assertUpsertRecruitmentCalendarCommand,
  type RecruitmentCalendarChannel,
  type RecruitmentCalendarResult,
} from './recruitment-calendar.adapter.js';

const command = {
  tenantId: 'tenant-001',
  interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
  version: 1,
  externalCalendarId: 'calendar-001',
  startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z',
  timezone: 'Asia/Shanghai',
  organizerExternalId: 'user-001',
  attendeeExternalIds: ['user-001', 'user-002'],
  location: '会议室 A',
  currentExternalEventId: null,
  idempotencyKey: 'tenant-001:calendar:interview:1:upsert',
};

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

  it('运行时未知渠道即使绕过 TypeScript 也失败关闭', () => {
    const registry = new RecruitmentCalendarAdapterRegistry(
      new FakeCalendarAdapter('dingtalk'), new FakeCalendarAdapter('feishu'),
    );
    expect(() => registry.get('op' as RecruitmentCalendarChannel))
      .toThrow('日历适配器未装配：op');
  });
});

describe('RecruitmentCalendarAdapter 运行时契约', () => {
  it('接受标准写入、取消与外部事件标识', () => {
    expect(() => assertUpsertRecruitmentCalendarCommand(command)).not.toThrow();
    expect(() => assertCancelRecruitmentCalendarCommand({
      tenantId: command.tenantId,
      interviewId: command.interviewId,
      version: 2,
      externalCalendarId: command.externalCalendarId,
      organizerExternalId: command.organizerExternalId,
      externalEventId: 'event-001',
      idempotencyKey: 'tenant-001:calendar:interview:2:cancel',
    })).not.toThrow();
    expect(assertRecruitmentCalendarExternalEventId('event-001')).toBe('event-001');
  });

  it.each([
    ['tenant', { tenantId: 'bad tenant' }],
    ['interview', { interviewId: 'bad' }],
    ['version unsafe', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['version zero', { version: 0 }],
    ['calendar', { externalCalendarId: 'bad id' }],
    ['start format', { startsAt: '2026-07-22T08:00:00Z' }],
    ['start invalid', { startsAt: '2026-02-30T08:00:00.000Z' }],
    ['end format', { endsAt: 'bad' }],
    ['range', { endsAt: command.startsAt }],
    ['timezone empty', { timezone: '' }],
    ['timezone long', { timezone: 'A'.repeat(65) }],
    ['timezone control', { timezone: 'Asia/Shanghai\n' }],
    ['timezone unknown', { timezone: 'Unknown/Zone' }],
    ['organizer', { organizerExternalId: 'bad id' }],
    ['attendees type', { attendeeExternalIds: null }],
    ['attendees empty', { attendeeExternalIds: [] }],
    ['attendees excess', { attendeeExternalIds: Array.from(
      { length: 101 },
      (_, index) => `user-${String(index).padStart(3, '0')}`,
    ) }],
    ['attendee invalid', { attendeeExternalIds: ['user-001', 'bad id'] }],
    ['attendee duplicate', { attendeeExternalIds: ['user-001', 'user-001'] }],
    ['organizer first', { attendeeExternalIds: ['user-002', 'user-001'] }],
    ['location type', { location: null }],
    ['location empty', { location: '' }],
    ['location long', { location: 'A'.repeat(513) }],
    ['location control', { location: 'A\nB' }],
    ['current event', { currentExternalEventId: 'bad id' }],
    ['idempotency', { idempotencyKey: 'short' }],
  ])('拒绝非法写入命令：%s', (_label, patch) => {
    expect(() => assertUpsertRecruitmentCalendarCommand({
      ...command,
      ...patch,
    } as typeof command)).toThrowError(RecruitmentCalendarError);
  });

  it.each([
    ['tenant', { tenantId: 'bad tenant' }],
    ['interview', { interviewId: 'bad' }],
    ['version unsafe', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['version zero', { version: 0 }],
    ['calendar', { externalCalendarId: 'bad id' }],
    ['organizer', { organizerExternalId: 'bad id' }],
    ['event', { externalEventId: 'bad id' }],
    ['key', { idempotencyKey: 'short' }],
  ])('拒绝非法取消命令：%s', (_label, patch) => {
    expect(() => assertCancelRecruitmentCalendarCommand({
      tenantId: command.tenantId,
      interviewId: command.interviewId,
      version: 2,
      externalCalendarId: command.externalCalendarId,
      organizerExternalId: command.organizerExternalId,
      externalEventId: 'event-001',
      idempotencyKey: 'tenant-001:calendar:interview:2:cancel',
      ...patch,
    })).toThrowError(RecruitmentCalendarError);
  });

  it.each(['', 'bad id', 'A'.repeat(513)])('拒绝非法平台事件标识', (value) => {
    expect(() => assertRecruitmentCalendarExternalEventId(value))
      .toThrowError(RecruitmentCalendarError);
  });
});
