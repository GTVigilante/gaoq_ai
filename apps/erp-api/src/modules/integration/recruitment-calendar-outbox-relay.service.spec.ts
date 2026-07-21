import type { ClientSession, Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import type { OrgPlatformBindingDocument } from './org-platform-binding.schema.js';
import type { RecruitmentCalendarBindingDocument } from './recruitment-calendar-binding.schema.js';
import type { RecruitmentCalendarDeliveryDocument } from './recruitment-calendar-delivery.schema.js';
import { RecruitmentCalendarOutboxRelayService } from './recruitment-calendar-outbox-relay.service.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X0';
const event = {
  eventId: EVENT_ID, tenantId: 'tenant-001', aggregateType: 'recruitment.interview',
  aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4X1', aggregateVersion: 1,
  eventType: 'cn.gaoq.erp.recruitment.interview.scheduled.v1', attempts: 0,
};

function query(result: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

function fixture(options?: { readonly event?: unknown; readonly channels?: readonly string[] }) {
  const findOneAndUpdate = vi.fn().mockReturnValueOnce(query(options?.event ?? event))
    .mockReturnValue(query(null));
  const outboxUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const deliveryUpdateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
  const deliveryFind = vi.fn().mockReturnValue(query([]));
  const platformBindingFind = vi.fn().mockReturnValue(query(
    (options?.channels ?? ['dingtalk', 'feishu']).map((channel) => ({ channel })),
  ));
  const calendarBindingFind = vi.fn().mockReturnValue(query(
    (options?.channels ?? ['dingtalk', 'feishu']).map((channel) => ({
      channel, externalCalendarId: `${channel}-recruitment-calendar`,
    })),
  ));
  const session = {
    withTransaction: vi.fn((operation: () => Promise<unknown>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClientSession;
  const connection = { startSession: vi.fn().mockResolvedValue(session) } as unknown as Connection;
  const deliveryModel = { updateOne: deliveryUpdateOne, find: deliveryFind } as unknown as Model<
    RecruitmentCalendarDeliveryDocument
  >;
  const service = new RecruitmentCalendarOutboxRelayService(
    connection,
    { findOneAndUpdate, updateOne: outboxUpdateOne } as unknown as Model<OutboxDocument>,
    deliveryModel,
    { find: platformBindingFind } as unknown as Model<OrgPlatformBindingDocument>,
    { find: calendarBindingFind } as unknown as Model<RecruitmentCalendarBindingDocument>,
  );
  return {
    service, findOneAndUpdate, outboxUpdateOne, deliveryUpdateOne,
    deliveryFind, platformBindingFind, calendarBindingFind, session,
  };
}

describe('RecruitmentCalendarOutboxRelayService', () => {
  it('按租户已启用绑定在同一事务扇出日历投递', async () => {
    const store = fixture();
    await expect(store.service.relayBatch('calendar-worker-001', 10)).resolves.toBe(1);
    expect(store.platformBindingFind).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', status: 'active' }, { channel: 1, _id: 0 },
    );
    expect(store.calendarBindingFind).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', status: 'active' },
      { channel: 1, externalCalendarId: 1, _id: 0 },
    );
    expect(store.deliveryUpdateOne).toHaveBeenCalledTimes(2);
    expect(store.deliveryUpdateOne.mock.calls.map((call): unknown => call[0] as unknown)).toEqual([
      {
        tenantId: 'tenant-001', eventId: EVENT_ID, channel: 'dingtalk',
        externalCalendarId: 'dingtalk-recruitment-calendar',
      },
      {
        tenantId: 'tenant-001', eventId: EVENT_ID, channel: 'feishu',
        externalCalendarId: 'feishu-recruitment-calendar',
      },
    ]);
    expect(store.outboxUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
  });

  it('只抢占面试聚合，不与组织 Relay 争抢事件', async () => {
    const store = fixture({ event: null });
    await store.service.relayBatch('calendar-worker-001', 1);
    expect(store.findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      aggregateType: 'recruitment.interview',
    });
  });

  it('未配置日历绑定时保留 Outbox 并退避，不伪装投递成功', async () => {
    const store = fixture({ channels: [] });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'pending', attempts: 1,
        lastErrorCode: 'RECRUITMENT_CALENDAR_RELAY_FAILED',
      },
    });
  });

  it('已完成面试事件明确确认但不产生日历写入', async () => {
    const store = fixture({
      event: {
        ...event, aggregateVersion: 3,
        eventType: 'cn.gaoq.erp.recruitment.interview.completed.v1',
      },
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.platformBindingFind).not.toHaveBeenCalled();
    expect(store.calendarBindingFind).not.toHaveBeenCalled();
  });

  it('取消事件固定复用原排期目标，不受当前默认日历切换影响', async () => {
    const store = fixture({
      event: {
        ...event, aggregateVersion: 2,
        eventType: 'cn.gaoq.erp.recruitment.interview.cancelled.v1',
      },
    });
    store.deliveryFind.mockReturnValue(query([
      { channel: 'feishu', externalCalendarId: 'original-calendar' },
    ]));

    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(1);

    expect(store.platformBindingFind).not.toHaveBeenCalled();
    expect(store.calendarBindingFind).not.toHaveBeenCalled();
    expect(store.deliveryUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $setOnInsert: {
        action: 'cancel', channel: 'feishu', externalCalendarId: 'original-calendar',
      },
    });
  });
});
