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
    const session = {};
    await expect(service.assertDispatchable(identity, session as never)).resolves.toBe(true);
    const filter = records.findOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toMatchObject(identity);
    expect(records.queries[0]?.session).toHaveBeenCalledWith(session);

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
    const dead = new MarketingSideEffectDeliveryService(
      modelWithState('dead') as never,
    );
    await expect(dead.assertDispatchable(identity)).rejects.toThrow(
      'MARKETING_SIDE_EFFECT_ROUTE_MISMATCH',
    );
  });

  it('成功送达单调增加 deliveryAttempts，最终失败进入 dead 终态', async () => {
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
        lastErrorCode: null,
      },
      $max: { deliveryAttempts: 2 },
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
        lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
      },
      $max: { deliveryAttempts: 6 },
    });
  });

  it.each([
    [{ ...identity, eventId: 'invalid' }],
    [{ ...identity, tenantId: ' tenant-001' }],
    [{ ...identity, aggregateId: '' }],
    [{ ...identity, aggregateVersion: 0 }],
    [{ ...identity, aggregateVersion: 1.5 }],
    [{ ...identity, kind: 'unknown', channel: null }],
    [{ ...identity, kind: 'lead_notification', channel: null }],
    [{ ...identity, kind: 'scheduled_publish', channel: 'email' }],
  ])('运行时拒绝非法副作用身份 %#', async (candidate) => {
    const records = modelWithState('dispatched');
    const service = new MarketingSideEffectDeliveryService(records as never);
    await expect(service.assertDispatchable(candidate as never)).rejects.toThrow(
      'MARKETING_SIDE_EFFECT_IDENTITY_INVALID',
    );
    expect(records.findOne).not.toHaveBeenCalled();
  });

  it('把路由存储异常归一化为稳定错误码', async () => {
    const records = modelWithState(new Error('mongodb details'));
    const service = new MarketingSideEffectDeliveryService(records as never);
    await expect(service.assertDispatchable(identity)).rejects.toThrow(
      'MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE',
    );
  });

  it('送达终态重复写入幂等通过，并把会话绑定到终态复核', async () => {
    const records = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [{ _id: 'side-effect-001' }],
    });
    const service = new MarketingSideEffectDeliveryService(records as never);
    const session = {};
    await expect(service.markDelivered(identity, 3, session as never)).resolves.toBeUndefined();
    expect(records.exists).toHaveBeenCalledWith({
      ...identity,
      status: 'delivered',
    });
    expect(records.queries.at(-1)?.session).toHaveBeenCalledWith(session);
  });

  it('送达写入丢失状态或存储不可用时失败关闭', async () => {
    const lost = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [null],
    });
    await expect(
      new MarketingSideEffectDeliveryService(lost as never).markDelivered(identity, 1),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');

    const unavailable = modelWithState('dispatched', {
      updateError: new Error('mongodb details'),
    });
    await expect(
      new MarketingSideEffectDeliveryService(unavailable as never)
        .markDelivered(identity, 1),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');

    const verificationUnavailable = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [new Error('mongodb details')],
    });
    await expect(
      new MarketingSideEffectDeliveryService(verificationUnavailable as never)
        .markDelivered(identity, 1),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');
  });

  it('失败尝试不会被并发旧尝试回退，终态重复写入幂等通过', async () => {
    const terminal = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [{ _id: 'terminal' }],
    });
    await expect(
      new MarketingSideEffectDeliveryService(terminal as never)
        .markFailure(identity, 4, true, 'MARKETING_GATEWAY_FAILED'),
    ).resolves.toBeUndefined();

    const stale = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [null, { _id: 'newer-attempt' }],
    });
    await expect(
      new MarketingSideEffectDeliveryService(stale as never)
        .markFailure(identity, 3, false, 'MARKETING_GATEWAY_FAILED'),
    ).resolves.toBeUndefined();
    expect(stale.exists.mock.calls[1]?.[0]).toEqual({
      ...identity,
      status: 'dispatched',
      deliveryAttempts: { $gte: 3 },
    });
  });

  it('失败状态不存在、复核失败或存储失败时使用稳定错误码失败关闭', async () => {
    const lost = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [null, null],
    });
    await expect(
      new MarketingSideEffectDeliveryService(lost as never)
        .markFailure(identity, 2, false, 'MARKETING_GATEWAY_FAILED'),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');

    const unavailable = modelWithState('dispatched', {
      updateError: new Error('mongodb details'),
    });
    await expect(
      new MarketingSideEffectDeliveryService(unavailable as never)
        .markFailure(identity, 2, false, 'MARKETING_GATEWAY_FAILED'),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');

    const verificationUnavailable = modelWithState('dispatched', {
      updateMatchedCount: 0,
      existsResults: [new Error('mongodb details')],
    });
    await expect(
      new MarketingSideEffectDeliveryService(verificationUnavailable as never)
        .markFailure(identity, 2, false, 'MARKETING_GATEWAY_FAILED'),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');
  });

  it.each([0, 101, 1.5])('拒绝非法送达尝试次数 %s', async (attempt) => {
    const records = modelWithState('dispatched');
    const service = new MarketingSideEffectDeliveryService(records as never);
    await expect(service.markDelivered(identity, attempt)).rejects.toThrow(
      'MARKETING_SIDE_EFFECT_ATTEMPT_INVALID',
    );
    await expect(
      service.markFailure(identity, attempt, false, 'MARKETING_GATEWAY_FAILED'),
    ).rejects.toThrow('MARKETING_SIDE_EFFECT_ATTEMPT_INVALID');
    expect(records.updateOne).not.toHaveBeenCalled();
  });

  it.each(['raw details', 'AA', 'A'.repeat(129)])(
    '拒绝非法失败错误码 %#',
    async (errorCode) => {
      const records = modelWithState('dispatched');
      const service = new MarketingSideEffectDeliveryService(records as never);
      await expect(
        service.markFailure(identity, 1, false, errorCode),
      ).rejects.toThrow('MARKETING_SIDE_EFFECT_ERROR_CODE_INVALID');
      expect(records.updateOne).not.toHaveBeenCalled();
    },
  );
});

interface ModelOptions {
  readonly updateMatchedCount?: number;
  readonly updateError?: Error;
  readonly existsResults?: readonly (object | null | Error)[];
}

function modelWithState(
  initialState: string | null | Error,
  options: ModelOptions = {},
) {
  const existsResults = [...(options.existsResults ?? [])];
  const records = {
    state: initialState,
    findOne: vi.fn(),
    updateOne: options.updateError === undefined
      ? vi.fn().mockResolvedValue({ matchedCount: options.updateMatchedCount ?? 1 })
      : vi.fn().mockRejectedValue(options.updateError),
    exists: vi.fn(),
    queries: [] as ReturnType<typeof query>[],
  };
  records.findOne.mockImplementation(() => {
    const result = records.state instanceof Error
      ? records.state
      : records.state === null
        ? null
        : { status: records.state };
    const item = query(result);
    records.queries.push(item);
    return item;
  });
  records.exists.mockImplementation(() => {
    const item = query(existsResults.shift() ?? null);
    records.queries.push(item);
    return item;
  });
  return records;
}

function query<T>(result: T | Error) {
  const chain = {
    select: vi.fn(),
    lean: vi.fn(),
    session: vi.fn(),
    exec: result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  return chain;
}
