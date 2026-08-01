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

function fixture(options?: {
  readonly event?: unknown;
  readonly channels?: readonly string[];
  readonly platformChannels?: readonly string[];
  readonly calendarRecords?: readonly Readonly<Record<string, unknown>>[];
  readonly deliveryRecords?: readonly Readonly<Record<string, unknown>>[];
  readonly deliveryResult?: Readonly<Record<string, unknown>>;
  readonly outboxUpdateResults?: readonly { readonly matchedCount: number }[];
  readonly transactionError?: unknown;
  readonly cleanupError?: unknown;
}) {
  const claimed = options !== undefined && 'event' in options ? options.event : event;
  const findOneAndUpdate = vi.fn().mockReturnValueOnce(query(claimed))
    .mockReturnValue(query(null));
  const outboxUpdateOne = vi.fn();
  for (const result of options?.outboxUpdateResults ?? []) {
    outboxUpdateOne.mockResolvedValueOnce(result);
  }
  outboxUpdateOne.mockResolvedValue({ matchedCount: 1 });
  const deliveryUpdateOne = vi.fn().mockResolvedValue({
    acknowledged: true, upsertedCount: 1, ...options?.deliveryResult,
  });
  const deliveryFind = vi.fn().mockReturnValue(query(options?.deliveryRecords ?? []));
  const platformChannels = options?.platformChannels ?? options?.channels ?? ['dingtalk', 'feishu'];
  const platformBindingFind = vi.fn().mockReturnValue(query(
    platformChannels.map((channel) => ({ channel })),
  ));
  const calendarRecords = options?.calendarRecords ??
    (options?.channels ?? ['dingtalk', 'feishu']).map((channel) => ({
      channel, externalCalendarId: `${channel}-recruitment-calendar`,
    }));
  const calendarBindingFind = vi.fn().mockReturnValue(query(
    calendarRecords,
  ));
  const transactionError = options?.transactionError;
  const cleanupError = options?.cleanupError;
  const withTransaction = vi.fn((operation: () => Promise<unknown>) =>
    transactionError === undefined
      ? operation()
      : Promise.reject(transactionError instanceof Error
          ? transactionError
          : new Error('事务失败')));
  const endSession = cleanupError === undefined
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(cleanupError instanceof Error
        ? cleanupError
        : new Error('会话清理失败'));
  const session = {
    withTransaction,
    endSession,
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
    deliveryFind, platformBindingFind, calendarBindingFind, session, connection,
    withTransaction, endSession,
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

  it('迁移面试事件明确确认且不触发日历副作用或死信重试', async () => {
    const store = fixture({
      event: {
        ...event, aggregateVersion: 4,
        eventType: 'cn.gaoq.erp.recruitment.interview.migrated.v1',
      },
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.platformBindingFind).not.toHaveBeenCalled();
    expect(store.calendarBindingFind).not.toHaveBeenCalled();
    expect(store.outboxUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
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

  it('没有可抢占事件时立即结束', async () => {
    const store = fixture({ event: null });
    await expect(store.service.relayBatch('calendar-worker-001', 3)).resolves.toBe(0);
    expect(store.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['', 1],
    ['bad worker', 1],
    ['calendar-worker-001', 0],
    ['calendar-worker-001', 101],
    ['calendar-worker-001', 1.5],
  ])('拒绝非法 workerId 或批量上限：%s/%s', async (workerId, limit) => {
    const store = fixture();
    await expect(store.service.relayBatch(workerId, limit)).rejects.toThrow();
    expect(store.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['eventId', { eventId: 'bad' }],
    ['tenantId', { tenantId: 'bad tenant' }],
    ['aggregateId', { aggregateId: 'bad' }],
    ['version unsafe', { aggregateVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['version zero', { aggregateVersion: 0 }],
    ['event type', { eventType: 'bad type' }],
    ['attempts fraction', { attempts: 0.5 }],
    ['attempts negative', { attempts: -1 }],
    ['attempts exhausted', { attempts: 6 }],
  ])('损坏 Outbox %s 失败关闭并按上限释放', async (_label, patch) => {
    const store = fixture({ event: { ...event, ...patch } });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.withTransaction).not.toHaveBeenCalled();
    const invalidAttempts = (patch as { readonly attempts?: number }).attempts;
    expect(store.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: invalidAttempts === 0.5 || invalidAttempts === -1 || invalidAttempts === 6
          ? 'dead'
          : 'pending',
        lastErrorCode: 'RECRUITMENT_CALENDAR_RELAY_FAILED',
      },
    });
  });

  it('合法命名但未支持的面试事件明确释放而不建投递', async () => {
    const store = fixture({
      event: {
        ...event,
        eventType: 'cn.gaoq.erp.recruitment.interview.rescheduled.v1',
      },
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending', attempts: 1 },
    });
  });

  it('只对平台和日历均启用的去重目标建投递', async () => {
    const store = fixture({
      platformChannels: ['feishu'],
      calendarRecords: [
        { channel: 'dingtalk', externalCalendarId: 'calendar-dt' },
        { channel: 'feishu', externalCalendarId: 'calendar-fs' },
        { channel: 'feishu', externalCalendarId: 'calendar-fs' },
      ],
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.deliveryUpdateOne).toHaveBeenCalledOnce();
    expect(store.deliveryUpdateOne.mock.calls[0]?.[0]).toMatchObject({
      channel: 'feishu',
      externalCalendarId: 'calendar-fs',
    });
  });

  it.each([
    [{ channel: 'op', externalCalendarId: 'calendar-001' }],
    [{ channel: 'feishu', externalCalendarId: 'bad calendar' }],
  ])('启用目标损坏时拒绝扇出', async (calendarRecord) => {
    const store = fixture({
      platformChannels: [String(calendarRecord.channel)],
      calendarRecords: [calendarRecord],
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending' },
    });
  });

  it('取消目标去重并按渠道稳定排序', async () => {
    const store = fixture({
      event: {
        ...event,
        aggregateVersion: 2,
        eventType: 'cn.gaoq.erp.recruitment.interview.cancelled.v1',
      },
      deliveryRecords: [
        { channel: 'feishu', externalCalendarId: 'calendar-fs' },
        { channel: 'dingtalk', externalCalendarId: 'calendar-dt' },
        { channel: 'feishu', externalCalendarId: 'calendar-fs' },
      ],
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.deliveryUpdateOne.mock.calls.map((call) => (
      call[0] as { readonly channel: string }
    ).channel)).toEqual(['dingtalk', 'feishu']);
  });

  it('取消历史目标损坏时失败关闭', async () => {
    const store = fixture({
      event: {
        ...event,
        aggregateVersion: 2,
        eventType: 'cn.gaoq.erp.recruitment.interview.cancelled.v1',
      },
      deliveryRecords: [{ channel: 'op', externalCalendarId: 'calendar-001' }],
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
  });

  it('投递写入未确认时事务失败并释放 Outbox', async () => {
    const store = fixture({ deliveryResult: { acknowledged: false } });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'pending', attempts: 1 },
    });
  });

  it('事务内 Outbox 租约丢失时释放失败并向上抛出', async () => {
    const store = fixture({
      outboxUpdateResults: [{ matchedCount: 0 }, { matchedCount: 0 }],
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1))
      .rejects.toThrow('RECRUITMENT_CALENDAR_RELAY_CLAIM_LOST');
    expect(store.outboxUpdateOne).toHaveBeenCalledTimes(2);
  });

  it('事务失败且会话清理也失败时保留事务错误并正常释放', async () => {
    const transactionError = new Error('事务失败');
    const store = fixture({
      transactionError,
      cleanupError: new Error('清理失败'),
    });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.outboxUpdateOne).toHaveBeenCalledOnce();
    expect(store.outboxUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'pending' },
    });
  });

  it('事务已提交但会话清理失败时停止批次且禁止释放重放', async () => {
    const store = fixture({ cleanupError: new Error('清理失败') });
    await expect(store.service.relayBatch('calendar-worker-001', 2))
      .rejects.toThrow('日历 Relay 已提交但会话清理失败');
    expect(store.outboxUpdateOne).toHaveBeenCalledOnce();
    expect(store.outboxUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
    expect(store.findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it('达到最大尝试次数时进入 dead 且不再计算退避', async () => {
    const store = fixture({ event: { ...event, attempts: 5 }, channels: [] });
    await expect(store.service.relayBatch('calendar-worker-001', 1)).resolves.toBe(0);
    const update = store.outboxUpdateOne.mock.calls.at(-1)?.[1] as {
      readonly $set: { readonly status: string; readonly attempts: number };
    };
    expect(update.$set).toMatchObject({ status: 'dead', attempts: 6 });
  });
});
