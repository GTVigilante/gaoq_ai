import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityRefreshTokenDocument } from './refresh-token.schema.js';
import { RefreshTokenService } from './refresh-token.service.js';
import type { SessionService } from './session.service.js';

const validRefreshToken = `rt_${'A'.repeat(64)}`;
const mongoSession = {} as ClientSession;

const createFixture = () => {
  const findOneAndUpdate = vi.fn();
  const create = vi.fn().mockResolvedValue([]);
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const exec = vi.fn();
  const findOne = vi.fn().mockReturnValue({
    session: () => ({ lean: () => ({ exec }) }),
  });
  const model = { findOneAndUpdate, create, updateOne, updateMany, findOne };
  const revoke = vi.fn().mockResolvedValue(true);
  const sessions = { revoke } as unknown as SessionService;
  return {
    service: new RefreshTokenService(
      model as unknown as Model<IdentityRefreshTokenDocument>,
      sessions,
    ),
    findOneAndUpdate,
    create,
    updateOne,
    updateMany,
    findOne,
    exec,
    revoke,
  };
};

describe('RefreshTokenService', () => {
  it('拒绝格式异常的刷新令牌且不查询数据库', async () => {
    const fixture = createFixture();

    await expect(fixture.service.rotate('not-a-token', 'gaoq-web', mongoSession)).resolves.toEqual({
      status: 'invalid',
    });
    expect(fixture.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('原子消费有效令牌并生成同 family 下一代令牌', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue({
      _id: 'token-id',
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      familyId: 'family-001',
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession);

    expect(result).toMatchObject({
      status: 'rotated',
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
    });
    if (result.status !== 'rotated') {
      throw new Error('预期刷新令牌轮换成功');
    }
    expect(result.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{64}$/);
    const rotationCall = fixture.findOneAndUpdate.mock.calls[0];
    expect(rotationCall?.[0]).toMatchObject({
      clientId: 'gaoq-web',
      consumedAt: { $exists: false },
      revokedAt: { $exists: false },
    });
    const rotationUpdate = rotationCall?.[1] as { readonly $set: { readonly consumedAt: unknown } };
    expect(rotationUpdate.$set.consumedAt).toBeInstanceOf(Date);
    expect(rotationCall?.[2]).toEqual({ returnDocument: 'after', session: mongoSession });
    const created = fixture.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(created[0]).toMatchObject({ familyId: 'family-001', generation: 1 });
    expect(created[0]?.['tokenHash']).not.toBe(result.refreshToken);
    expect(fixture.updateOne).toHaveBeenCalledOnce();
  });

  it('已消费令牌重放时吊销整个 family 和服务端会话', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue(null);
    fixture.exec.mockResolvedValue({
      tenantId: 'tenant-001',
      sessionId: 'session-001',
      familyId: 'family-001',
    });

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).resolves.toEqual({ status: 'replay' });
    const replayCall = fixture.updateMany.mock.calls[0];
    expect(replayCall?.[0]).toEqual({
      tenantId: 'tenant-001',
      familyId: 'family-001',
      revokedAt: { $exists: false },
    });
    const replayUpdate = replayCall?.[1] as { readonly $set: { readonly revokedAt: unknown } };
    expect(replayUpdate.$set.revokedAt).toBeInstanceOf(Date);
    expect(replayCall?.[2]).toEqual({ session: mongoSession });
    expect(fixture.revoke).toHaveBeenCalledWith('tenant-001', 'session-001', mongoSession);
  });

  it('随机未知令牌只返回 invalid，不产生批量吊销', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue(null);
    fixture.exec.mockResolvedValue(null);

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).resolves.toEqual({ status: 'invalid' });
    expect(fixture.updateMany).not.toHaveBeenCalled();
    expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it('离职批量吊销强制租户、去重主体、未吊销过滤与事务透传', async () => {
    const fixture = createFixture();
    fixture.updateMany.mockResolvedValue({ modifiedCount: 5 });
    await expect(fixture.service.revokeAllByActors(
      'tenant-001', ['actor-001', 'actor-001', 'actor-002'], mongoSession,
    )).resolves.toBe(5);
    const revokeCall = fixture.updateMany.mock.calls.at(-1);
    expect(revokeCall?.[0]).toEqual({
      tenantId: 'tenant-001',
      actorId: { $in: ['actor-001', 'actor-002'] },
      revokedAt: { $exists: false },
    });
    const revokeUpdate = revokeCall?.[1] as { readonly $set: { readonly revokedAt: unknown } };
    expect(revokeUpdate.$set.revokedAt).toBeInstanceOf(Date);
    expect(revokeCall?.[2]).toEqual({ session: mongoSession });
  });

  it('批量刷新令牌吊销拒绝空数组和操作符形态主体且不访问数据库', async () => {
    const fixture = createFixture();
    await expect(fixture.service.revokeAllByActors(
      'tenant-001', [], mongoSession,
    )).rejects.toThrow('参数非法');
    await expect(fixture.service.revokeAllByActors(
      'tenant-001', ['$ne'], mongoSession,
    )).rejects.toThrow('参数非法');
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });
});
