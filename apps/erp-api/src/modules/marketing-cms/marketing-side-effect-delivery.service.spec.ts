import { describe, expect, it, vi } from 'vitest';
import {
  MarketingSideEffectDeliveryService,
  type MarketingSideEffectIdentity,
} from './marketing-side-effect-delivery.service.js';

const identity: MarketingSideEffectIdentity = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
  tenantId: 'tenant-001',
  kind: 'lead_notification',
  aggregateId: 'lead-001',
  aggregateVersion: 1,
  channel: 'email',
};

describe('营销副作用送达终态', () => {
  it('只接受完整租户与路由身份匹配的 dispatched 记录', async () => {
    const records = modelWithState('dispatched');
    const service = new MarketingSideEffectDeliveryService(records as never);
    await expect(service.assertDispatchable(identity)).resolves.toBe(true);
    const filter = records.findOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toMatchObject(identity);

    records.state = null;
    await expect(service.assertDispatchable({
      ...identity,
      tenantId: 'tenant-other',
    })).rejects.toThrow('MARKETING_SIDE_EFFECT_ROUTE_MISMATCH');
  });

  it('已送达或已取消记录幂等跳过，不重复执行副作用', async () => {
    const delivered = new MarketingSideEffectDeliveryService(
      modelWithState('delivered') as never,
    );
    await expect(delivered.assertDispatchable(identity)).resolves.toBe(false);
    const cancelled = new MarketingSideEffectDeliveryService(
      modelWithState('cancelled') as never,
    );
    await expect(cancelled.assertDispatchable(identity)).resolves.toBe(false);
  });

  it('成功送达写入 deliveryAttempts，最终失败进入 dead 终态', async () => {
    const records = modelWithState('dispatched');
    const service = new MarketingSideEffectDeliveryService(records as never);
    await service.markDelivered(identity, 2);
    expect(records.updateOne.mock.calls[0]?.[0]).toMatchObject({
      ...identity,
      status: 'dispatched',
    });
    expect(records.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        status: 'delivered',
        deliveryAttempts: 2,
        lastErrorCode: null,
      },
    });

    await service.markFailure(
      identity,
      6,
      true,
      'MARKETING_NOTIFICATION_GATEWAY_FAILED',
    );
    expect(records.updateOne.mock.calls[1]?.[1]).toMatchObject({
      $set: {
        status: 'dead',
        deliveryAttempts: 6,
        lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
      },
    });
  });
});

function modelWithState(initialState: string | null) {
  const records = {
    state: initialState,
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    exists: vi.fn(),
  };
  records.findOne.mockImplementation(() => query(() =>
    records.state === null ? null : { status: records.state }));
  records.exists.mockImplementation(() => query(() => ({ _id: 'side-effect-001' })));
  return records;
}

function query<T>(result: () => T) {
  const chain = {
    select: vi.fn(),
    lean: vi.fn(),
    session: vi.fn(),
    exec: vi.fn().mockImplementation(() => Promise.resolve(result())),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  return chain;
}
