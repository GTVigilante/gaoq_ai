import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdentitySessionDocument } from './session.schema.js';
import { SessionService } from './session.service.js';

const createModel = () => ({
  findOne: vi.fn(),
  create: vi.fn(),
  updateOne: vi.fn<
    (filter: unknown, update: unknown, options: unknown) => Promise<{ readonly modifiedCount: number }>
  >(),
  updateMany: vi.fn<
    (filter: unknown, update: unknown, options: unknown) => Promise<{ readonly modifiedCount: number }>
  >(),
});

const createService = (model: ReturnType<typeof createModel>): SessionService =>
  new SessionService(model as unknown as Model<IdentitySessionDocument>);

const setSessionResult = (
  model: ReturnType<typeof createModel>,
  result: { readonly expiresAt: Date; readonly revokedAt?: Date } | null,
): void => {
  model.findOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve(result) }),
  });
};

describe('SessionService', () => {
  it('非法租户或会话标识直接失败关闭且不构造查询', async () => {
    const model = createModel();
    await expect(createService(model).isActive('$where', 'session-001', false)).resolves.toBe(false);
    await expect(createService(model).isActive('tenant-001', 'bad session', false)).resolves.toBe(false);
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('人员令牌对应的会话不存在时失败关闭', async () => {
    const model = createModel();
    setSessionResult(model, null);

    await expect(createService(model).isActive('tenant-001', 'session-001', true)).resolves.toBe(
      false,
    );
    expect(model.findOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', sessionId: 'session-001' },
      { revokedAt: 1, expiresAt: 1 },
    );
  });

  it('外部授权服务器管理的服务令牌允许无本地会话', async () => {
    const model = createModel();
    setSessionResult(model, null);

    await expect(createService(model).isActive('tenant-001', 'service-session', false)).resolves.toBe(
      true,
    );
  });

  it('拒绝已吊销或过期的会话', async () => {
    const revokedModel = createModel();
    setSessionResult(revokedModel, {
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
    });
    const expiredModel = createModel();
    setSessionResult(expiredModel, { expiresAt: new Date(Date.now() - 60_000) });

    await expect(createService(revokedModel).isActive('tenant-001', 'revoked', true)).resolves.toBe(
      false,
    );
    await expect(createService(expiredModel).isActive('tenant-001', 'expired', true)).resolves.toBe(
      false,
    );
  });

  it('活动会话透传事务，受损日期状态失败关闭', async () => {
    const active = createModel();
    const session = vi.fn();
    active.findOne.mockReturnValue({
      session,
      lean: () => ({
        exec: () => Promise.resolve({ expiresAt: new Date(Date.now() + 60_000) }),
      }),
    });
    const mongoSession = {} as ClientSession;
    await expect(
      createService(active).isActive('tenant-001', 'session-001', true, mongoSession),
    ).resolves.toBe(true);
    expect(session).toHaveBeenCalledWith(mongoSession);

    const damaged = createModel();
    damaged.findOne.mockReturnValue({
      lean: () => ({
        exec: () => Promise.resolve({ expiresAt: 'not-a-date' }),
      }),
    });
    await expect(
      createService(damaged).isActive('tenant-001', 'session-001', true),
    ).resolves.toBe(false);
  });

  it('创建会话与吊销都强制携带租户', async () => {
    const model = createModel();
    model.create.mockResolvedValue({});
    model.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const service = createService(model);
    const expiresAt = new Date(Date.now() + 60_000);

    await service.open({
      tenantId: 'tenant-001',
      sessionId: 'session-001',
      actorId: 'actor-001',
      expiresAt,
    });
    const revokeStartedAt = Date.now();
    await expect(service.revoke('tenant-001', 'session-001')).resolves.toBe(true);
    const revokeFinishedAt = Date.now();

    expect(model.create).toHaveBeenCalledWith(
      [{
        tenantId: 'tenant-001',
        sessionId: 'session-001',
        actorId: 'actor-001',
        expiresAt,
      }],
      {},
    );
    const [filter, update] = model.updateOne.mock.calls[0] ?? [];
    expect(filter).toEqual({
      tenantId: 'tenant-001',
      sessionId: 'session-001',
      revokedAt: { $exists: false },
    });
    const revokedAt = (update as { readonly $set: { readonly revokedAt: Date } }).$set.revokedAt;
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(revokeStartedAt);
    expect(revokedAt.getTime()).toBeLessThanOrEqual(revokeFinishedAt);
    expect(model.updateOne.mock.calls[0]?.[2]).toEqual({});
  });

  it('创建会话拒绝操作符标识、非法日期和过期时间', async () => {
    const model = createModel();
    const service = createService(model);
    await expect(service.open({
      tenantId: '$where',
      sessionId: 'session-001',
      actorId: 'actor-001',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('会话创建参数非法');
    await expect(service.open({
      tenantId: 'tenant-001',
      sessionId: 'session-001',
      actorId: 'actor-001',
      expiresAt: new Date(Date.now() - 1),
    })).rejects.toThrow('会话创建参数非法');
    expect(model.create).not.toHaveBeenCalled();
  });

  it('非法会话吊销不查询，未命中返回 false，事务会话透传', async () => {
    const model = createModel();
    const service = createService(model);
    await expect(service.revoke('tenant-001', '$ne')).resolves.toBe(false);
    expect(model.updateOne).not.toHaveBeenCalled();

    model.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const mongoSession = {} as ClientSession;
    await expect(service.revoke('tenant-001', 'session-001', mongoSession)).resolves.toBe(false);
    expect(model.updateOne.mock.calls[0]?.[2]).toEqual({ session: mongoSession });
  });

  it('离职批量吊销强制租户、去重主体、未吊销过滤与事务透传', async () => {
    const model = createModel();
    model.updateMany.mockResolvedValue({ modifiedCount: 3 });
    const mongoSession = {} as ClientSession;
    const service = createService(model);
    await expect(service.revokeAllByActors(
      'tenant-001', ['actor-001', 'actor-001', 'actor-002'], mongoSession,
    )).resolves.toBe(3);
    const revokeCall = model.updateMany.mock.calls[0];
    expect(revokeCall?.[0]).toEqual({
      tenantId: 'tenant-001',
      actorId: { $in: ['actor-001', 'actor-002'] },
      revokedAt: { $exists: false },
    });
    const revokeUpdate = revokeCall?.[1] as { readonly $set: { readonly revokedAt: unknown } };
    expect(revokeUpdate.$set.revokedAt).toBeInstanceOf(Date);
    expect(revokeCall?.[2]).toEqual({ session: mongoSession });
  });

  it.each([
    { actorIds: [] },
    { actorIds: ['$where'] },
    { actorIds: Array.from({ length: 101 }, (_, index) => `actor-${index}`) },
  ])(
    '批量会话吊销非法主体数组在查询前失败关闭：%j',
    async ({ actorIds }) => {
      const model = createModel();
      await expect(createService(model).revokeAllByActors(
        'tenant-001', actorIds, {} as ClientSession,
      )).rejects.toThrow('参数非法');
      expect(model.updateMany).not.toHaveBeenCalled();
    },
  );
});
