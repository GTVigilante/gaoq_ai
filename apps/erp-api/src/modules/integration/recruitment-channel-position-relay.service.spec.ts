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
});
