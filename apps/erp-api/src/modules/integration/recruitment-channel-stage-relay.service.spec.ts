import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import { RecruitmentChannelStageRelayService } from './recruitment-channel-stage-relay.service.js';
import type { RecruitmentChannelStageDeliveryDocument } from './recruitment-channel.schemas.js';

function query<T>(value: T) {
  const chain = { lean: vi.fn(() => chain), exec: vi.fn().mockResolvedValue(value) };
  return chain;
}

function stageEvent(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    eventId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    tenantId: 'tenant-001',
    aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4E2',
    aggregateVersion: 3,
    aggregateType: 'recruitment.application',
    eventType: 'cn.gaoq.erp.recruitment.application.stage_changed.v1',
    envelope: { data: { to: 'screening' } },
    attempts: 0,
    ...overrides,
  };
}

function fixture(event: ReturnType<typeof stageEvent> | null = stageEvent()) {
  const outbox = {
    findOneAndUpdate: vi.fn()
      .mockImplementationOnce(() => query(event))
      .mockImplementation(() => query(null)),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const deliveries = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const service = new RecruitmentChannelStageRelayService(
    connection as unknown as Connection,
    outbox as unknown as Model<OutboxDocument>,
    deliveries as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
  );
  return { service, outbox, deliveries, session, connection };
}

describe('RecruitmentChannelStageRelayService', () => {
  it('阶段事件在事务内投影为脱敏且带版本的渠道回执轨迹', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4D1', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4D2', aggregateVersion: 4,
      aggregateType: 'recruitment.application',
      eventType: 'cn.gaoq.erp.recruitment.application.stage_changed.v1',
      envelope: { data: { to: 'offer_sent', reasonCode: '内部原因不得复制' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn()
        .mockImplementationOnce(() => query(event))
        .mockImplementationOnce(() => query(null)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const deliveries = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RecruitmentChannelStageRelayService(
      { startSession: vi.fn().mockResolvedValue(session) } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      deliveries as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    );
    await expect(service.relayBatch('stage-relay-001', 2)).resolves.toBe(1);
    const deliveryCall = deliveries.updateOne.mock.calls[0];
    expect(deliveryCall?.[0]).toEqual({ tenantId: 'tenant-001', eventId: event.eventId });
    expect((deliveryCall?.[1] as { $setOnInsert?: unknown }).$setOnInsert).toMatchObject({
      applicationId: event.aggregateId, applicationVersion: 4,
      stage: 'offer', status: 'pending', receiptFingerprint: null,
    });
    expect(JSON.stringify((deliveryCall?.[1] as { $setOnInsert?: unknown }).$setOnInsert))
      .not.toMatch(/reasonCode|内部原因/iu);
    expect(deliveryCall?.[2]).toMatchObject({ upsert: true, session, runValidators: true });
    expect((outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown }).$set)
      .toMatchObject({ status: 'dispatched', lastErrorCode: null });
  });

  it('畸形阶段事件在认领后释放锁并记录稳定错误码', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4D3', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4D4', aggregateVersion: 2,
      eventType: 'cn.gaoq.erp.recruitment.application.stage_changed.v1',
      envelope: { data: { to: 'unknown' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn()
        .mockImplementationOnce(() => query(event))
        .mockImplementationOnce(() => query(null)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const service = new RecruitmentChannelStageRelayService(
      { startSession: vi.fn() } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      { updateOne: vi.fn() } as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    );
    await expect(service.relayBatch('stage-relay-001', 2)).resolves.toBe(0);
    expect((outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'pending', attempts: 1, lockedAt: null, lockedBy: null,
      lastErrorCode: 'RECRUITMENT_CHANNEL_STAGE_EVENT_INVALID',
    });
  });

  it('释放失败事件时若租约已转移则失败关闭', async () => {
    const event = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4D5', tenantId: 'tenant-001',
      aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4D6', aggregateVersion: 2,
      eventType: 'cn.gaoq.erp.recruitment.application.stage_changed.v1',
      envelope: { data: { to: 'unknown' } }, attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(event)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    };
    const service = new RecruitmentChannelStageRelayService(
      { startSession: vi.fn() } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      { updateOne: vi.fn() } as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    );
    await expect(service.relayBatch('stage-relay-001', 1)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_STAGE_RELEASE_LEASE_LOST',
    );
  });

  it.each([
    ['', 1, 'RECRUITMENT_CHANNEL_WORKER_INVALID'],
    ['含 空格', 1, 'RECRUITMENT_CHANNEL_WORKER_INVALID'],
    ['stage-relay-001', 0, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
    ['stage-relay-001', 101, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
    ['stage-relay-001', 1.5, 'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID'],
  ])('拒绝非法 Worker 或批量上限', async (workerId, limit, expectedCode) => {
    const store = fixture(null);
    await expect(store.service.relayBatch(workerId, limit)).rejects.toThrow(expectedCode);
    expect(store.outbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有到期事件时返回零并保留精确认领条件', async () => {
    const store = fixture(null);
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    const filter = store.outbox.findOneAndUpdate.mock.calls[0]?.[0] as {
      aggregateType?: string;
      $or?: readonly unknown[];
    };
    expect(filter.aggregateType).toBe('recruitment.application');
    expect(filter.$or).toEqual([
      { status: 'pending' },
      {
        status: 'dispatching',
        lockedAt: { $lt: expect.any(Date) as Date },
      },
    ]);
  });

  it.each([null, 'invalid', 42])('拒绝非对象阶段事件负载：%s', async (data) => {
    const store = fixture(stageEvent({ envelope: { data } }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'RECRUITMENT_CHANNEL_STAGE_EVENT_INVALID',
    });
  });

  it('申请创建事件直接完成 Outbox 而不创建回执', async () => {
    const store = fixture(stageEvent({
      eventType: 'cn.gaoq.erp.recruitment.application.created.v1',
      aggregateVersion: 1,
      envelope: { data: {} },
    }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(1);
    expect(store.deliveries.updateOne).not.toHaveBeenCalled();
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('不支持的申请事件类型进入稳定失败状态', async () => {
    const store = fixture(stageEvent({
      eventType: 'cn.gaoq.erp.recruitment.application.updated.v1',
    }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_STAGE_EVENT_UNSUPPORTED',
    });
  });

  it.each([
    [1, 'screening'],
    [2, 123],
  ])('拒绝非法阶段事件版本或目标类型', async (version, targetStage) => {
    const store = fixture(stageEvent({
      aggregateVersion: version,
      envelope: { data: { to: targetStage } },
    }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it.each([
    ['screening', 'screening'],
    ['interview', 'interview'],
    ['offer_approval', 'offer'],
    ['offer_sent', 'offer'],
    ['offer_accepted', 'offer'],
    ['preboarding', 'offer'],
    ['hired', 'hired'],
    ['rejected', 'rejected'],
    ['withdrawn', 'withdrawn'],
  ])('把内部阶段 %s 映射为渠道阶段 %s', async (targetStage, expectedStage) => {
    const store = fixture(stageEvent({ envelope: { data: { to: targetStage } } }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(1);
    const delivery = store.deliveries.updateOne.mock.calls[0]?.[1] as {
      $setOnInsert?: unknown;
    };
    expect(delivery.$setOnInsert).toMatchObject({ stage: expectedStage });
  });

  it('事务内 Outbox 认领丢失时释放事件并结束会话', async () => {
    const store = fixture();
    store.outbox.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    expect(store.session.endSession).toHaveBeenCalledOnce();
    const release = store.outbox.updateOne.mock.calls[1]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_OUTBOX_CLAIM_LOST',
    });
  });

  it('会话创建失败时释放事件并使用稳定兜底码', async () => {
    const store = fixture();
    store.connection.startSession.mockRejectedValueOnce(new Error('数据库暂时不可用'));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(release.$set).toMatchObject({
      lastErrorCode: 'RECRUITMENT_CHANNEL_STAGE_RELAY_FAILED',
    });
  });

  it('达到最大尝试次数后进入 dead 且不再退避', async () => {
    const store = fixture(stageEvent({
      envelope: { data: { to: 'unknown' } },
      attempts: 5,
    }));
    await expect(store.service.relayBatch('stage-relay-001', 1)).resolves.toBe(0);
    const release = store.outbox.updateOne.mock.calls[0]?.[1] as {
      $set?: { status?: string; attempts?: number; nextAttemptAt?: Date };
    };
    expect(release.$set).toMatchObject({ status: 'dead', attempts: 6 });
    expect(release.$set?.nextAttemptAt).toBeInstanceOf(Date);
  });
});
