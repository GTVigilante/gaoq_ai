import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import { RecruitmentChannelStageRelayService } from './recruitment-channel-stage-relay.service.js';
import type { RecruitmentChannelStageDeliveryDocument } from './recruitment-channel.schemas.js';

function query<T>(value: T) {
  const chain = { lean: vi.fn(() => chain), exec: vi.fn().mockResolvedValue(value) };
  return chain;
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
});
