import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import { RecruitmentChannelPositionRelayService } from './recruitment-channel-position-relay.service.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelPositionDeliveryDocument,
} from './recruitment-channel.schemas.js';

function query<T>(value: T) {
  const chain = { lean: vi.fn(() => chain), exec: vi.fn().mockResolvedValue(value) };
  return chain;
}

function positionEvent(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    eventId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
    tenantId: 'tenant-001',
    aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4D2',
    aggregateVersion: 3,
    aggregateType: 'recruitment.position',
    eventType: 'cn.gaoq.erp.recruitment.position.status_changed.v1',
    envelope: { data: { status: 'open' } },
    attempts: 0,
    ...overrides,
  };
}

function fixture(
  event: ReturnType<typeof positionEvent> | null = positionEvent(),
  targetBindings = [{
    id: '01J8ZQK7V0A2M4N6P8R0T2W4D3',
    tenantId: 'tenant-001',
    channelCode: 'sandbox_ats',
    status: 'active',
  }],
) {
  const outbox = {
    findOneAndUpdate: vi.fn()
      .mockImplementationOnce(() => query(event))
      .mockImplementation(() => query(null)),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const bindings = { find: vi.fn(() => query(targetBindings)) };
  const deliveries = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const service = new RecruitmentChannelPositionRelayService(
    connection as unknown as Connection,
    outbox as unknown as Model<OutboxDocument>,
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    deliveries as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
  );
  return { service, outbox, bindings, deliveries, session, connection };
}

describe('RecruitmentChannelPositionRelayService', () => {
  it('职位开放事件在事务内按活动渠道扇出投递并完成 Outbox', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4C1', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4C2', aggregateVersion: 2,
      aggregateType: 'recruitment.position',
      eventType: 'cn.gaoq.erp.recruitment.position.status_changed.v1',
      envelope: { data: { status: 'open' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn()
        .mockImplementationOnce(() => query(event))
        .mockImplementationOnce(() => query(null)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const bindings = { find: vi.fn(() => query([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C3', tenantId: 'tenant-001',
      channelCode: 'sandbox_ats', status: 'active',
    }])) };
    const deliveries = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RecruitmentChannelPositionRelayService(
      { startSession: vi.fn().mockResolvedValue(session) } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      bindings as unknown as Model<RecruitmentChannelBindingDocument>,
      deliveries as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    );
    await expect(service.relayBatch('worker-001', 2)).resolves.toBe(1);
    const deliveryCall = deliveries.updateOne.mock.calls[0];
    expect(deliveryCall?.[0]).toMatchObject({ tenantId: 'tenant-001', eventId: event.eventId });
    expect((deliveryCall?.[1] as { $setOnInsert?: unknown }).$setOnInsert).toMatchObject({
      channelCode: 'sandbox_ats', positionId: event.aggregateId,
      positionVersion: 2, action: 'publish', targetStatus: 'open', status: 'pending',
    });
    expect(deliveryCall?.[2]).toMatchObject({ upsert: true, session });
    const outboxCall = outbox.updateOne.mock.calls[0];
    expect(outboxCall?.[0]).toMatchObject({ eventId: event.eventId, status: 'dispatching' });
    expect((outboxCall?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'dispatched', lastErrorCode: null,
    });
    expect(outboxCall?.[2]).toEqual({ session, timestamps: false });
  });

  it('职位事件负载畸形时释放已认领 Outbox，避免锁悬挂', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4C4', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4C5', aggregateVersion: 2,
      eventType: 'cn.gaoq.erp.recruitment.position.status_changed.v1',
      envelope: { data: { status: 'unknown' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn()
        .mockImplementationOnce(() => query(event))
        .mockImplementationOnce(() => query(null)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const service = new RecruitmentChannelPositionRelayService(
      { startSession: vi.fn() } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      { find: vi.fn() } as unknown as Model<RecruitmentChannelBindingDocument>,
      { updateOne: vi.fn() } as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    );
    await expect(service.relayBatch('worker-001', 2)).resolves.toBe(0);
    expect((outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'pending', attempts: 1, lockedAt: null, lockedBy: null,
      lastErrorCode: 'RECRUITMENT_CHANNEL_POSITION_EVENT_INVALID',
    });
  });

  it('释放失败事件时若租约已转移则失败关闭', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4C7', aggregateVersion: 2,
      eventType: 'cn.gaoq.erp.recruitment.position.status_changed.v1',
      envelope: { data: { status: 'unknown' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(event)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    };
    const service = new RecruitmentChannelPositionRelayService(
      { startSession: vi.fn() } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      { find: vi.fn() } as unknown as Model<RecruitmentChannelBindingDocument>,
      { updateOne: vi.fn() } as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    );
    await expect(service.relayBatch('worker-001', 1)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_POSITION_RELEASE_LEASE_LOST',
    );
  });

  it.each([
    ['', 1, 'RECRUITMENT_CHANNEL_WORKER_INVALID'],
    ['含 空格', 1, 'RECRUITMENT_CHANNEL_WORKER_INVALID'],
    ['worker-001', 0, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
    ['worker-001', 101, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
    ['worker-001', 1.5, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
  ])('拒绝非法 Worker 或批量上限', async (workerId, limit, expectedCode) => {
    const store = fixture(null);
    await expect(store.service.relayBatch(workerId, limit)).rejects.toThrow(expectedCode);
    expect(store.outbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有到期事件时返回零并保留精确认领条件', async () => {
    const store = fixture(null);
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    const filter = store.outbox.findOneAndUpdate.mock.calls[0]?.[0] as {
      aggregateType?: string;
      $or?: readonly unknown[];
    };
    expect(filter.aggregateType).toBe('recruitment.position');
    expect(filter.$or).toEqual([
      { status: 'pending' },
      {
        status: 'dispatching',
        lockedAt: { $lt: expect.any(Date) as Date },
      },
    ]);
  });

  it.each([
    [null],
    ['invalid'],
    [42],
  ])('拒绝非对象职位事件负载：%s', async (data) => {
    const store = fixture(positionEvent({ envelope: { data } }));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'RECRUITMENT_CHANNEL_POSITION_EVENT_INVALID',
    });
  });

  it('职位创建草稿事件直接完成 Outbox 而不创建渠道投递', async () => {
    const store = fixture(positionEvent({
      eventType: 'cn.gaoq.erp.recruitment.position.created.v1',
      envelope: { data: { status: 'draft' } },
    }));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.bindings.find).not.toHaveBeenCalled();
    expect(store.deliveries.updateOne).not.toHaveBeenCalled();
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('职位创建事件若不是草稿则失败关闭', async () => {
    const store = fixture(positionEvent({
      eventType: 'cn.gaoq.erp.recruitment.position.created.v1',
      envelope: { data: { status: 'open' } },
    }));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it('不支持的职位事件类型进入稳定失败状态', async () => {
    const store = fixture(positionEvent({
      eventType: 'cn.gaoq.erp.recruitment.position.updated.v1',
    }));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_POSITION_EVENT_UNSUPPORTED',
    });
  });

  it.each(['draft', 'paused', 'closed'])(
    '非开放状态 %s 扇出 close 投递',
    async (status) => {
      const store = fixture(positionEvent({ envelope: { data: { status } } }));
      await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
      const delivery = store.deliveries.updateOne.mock.calls[0]?.[1] as {
        $setOnInsert?: unknown;
      };
      expect(delivery.$setOnInsert).toMatchObject({ action: 'close', targetStatus: status });
    },
  );

  it('每个活动渠道各创建一条幂等投递', async () => {
    const store = fixture(positionEvent(), [
      {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4D3',
        tenantId: 'tenant-001',
        channelCode: 'sandbox_ats',
        status: 'active',
      },
      {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4D4',
        tenantId: 'tenant-001',
        channelCode: 'linked_ats',
        status: 'active',
      },
    ]);
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.deliveries.updateOne).toHaveBeenCalledTimes(2);
  });

  it('事务内 Outbox 认领丢失时释放事件并结束会话', async () => {
    const store = fixture();
    store.outbox.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.session.endSession).toHaveBeenCalledOnce();
    const release = store.outbox.updateOne.mock.calls[1]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_OUTBOX_CLAIM_LOST',
    });
  });

  it('会话创建失败时释放事件并使用稳定兜底码', async () => {
    const store = fixture();
    store.connection.startSession.mockRejectedValueOnce(new Error('数据库暂时不可用'));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_POSITION_RELAY_FAILED',
    });
  });

  it('达到最大尝试次数后进入 dead 且不再退避', async () => {
    const store = fixture(positionEvent({
      envelope: { data: { status: 'unknown' } },
      attempts: 5,
    }));
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as {
      $set?: { status?: string; attempts?: number; nextAttemptAt?: Date };
    };
    expect(release.$set).toMatchObject({ status: 'dead', attempts: 6 });
    expect(release.$set?.nextAttemptAt).toBeInstanceOf(Date);
  });
});
