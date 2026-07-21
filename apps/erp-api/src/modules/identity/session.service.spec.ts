import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdentitySessionDocument } from './session.schema.js';
import { SessionService } from './session.service.js';

const createModel = () => ({
  findOne: vi.fn(),
  create: vi.fn(),
  updateOne: vi.fn<
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
});
