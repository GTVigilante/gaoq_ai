import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityRefreshTokenDocument } from './refresh-token.schema.js';
import { RefreshTokenService } from './refresh-token.service.js';
import type { SessionService } from './session.service.js';

const validRefreshToken = `rt_${'A'.repeat(64)}`;
const validFamilyId = '123e4567-e89b-42d3-a456-426614174000';
const mongoSession = {} as ClientSession;

const createFixture = () => {
  const findOneAndUpdate = vi.fn();
  const create = vi.fn().mockResolvedValue([]);
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
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
  it('首个刷新令牌只保存摘要、可信上下文与固定第零代', async () => {
    const fixture = createFixture();
    const expiresAt = new Date(Date.now() + 60_000);

    const result = await fixture.service.issueInitial({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt,
    }, mongoSession);

    expect(result.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{64}$/);
    expect(result.familyId).toMatch(/^[0-9a-f-]{36}$/);
    const created = fixture.create.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(created[0]).toMatchObject({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt,
    });
    expect(created[0]?.['tokenHash']).not.toBe(result.refreshToken);
    expect(fixture.create.mock.calls[0]?.[1]).toEqual({ session: mongoSession });
  });

  it.each([
    ['操作符租户', { tenantId: '$where' }],
    ['非法客户端', { clientId: 'bad client' }],
    ['已过期', { expiresAt: new Date(Date.now() - 1) }],
  ])('首个刷新令牌拒绝%s且不写数据库', async (_name, override) => {
    const fixture = createFixture();
    await expect(fixture.service.issueInitial({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt: new Date(Date.now() + 60_000),
      ...override,
    }, mongoSession)).rejects.toThrow('持久化状态非法');
    expect(fixture.create).not.toHaveBeenCalled();
  });

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
      familyId: validFamilyId,
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
    expect(created[0]).toMatchObject({ familyId: validFamilyId, generation: 1 });
    expect(created[0]?.['tokenHash']).not.toBe(result.refreshToken);
    expect(fixture.updateOne).toHaveBeenCalledOnce();
    const linkFilter = fixture.updateOne.mock.calls[0]?.[0] as {
      readonly tokenHash: unknown;
      readonly consumedAt: unknown;
      readonly replacedByHash: unknown;
    };
    expect(typeof linkFilter.tokenHash).toBe('string');
    expect(linkFilter.consumedAt).toBeInstanceOf(Date);
    expect(linkFilter.replacedByHash).toEqual({ $exists: false });
  });

  it('轮换链前驱 CAS 丢失时使事务失败，禁止提交孤立后继', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue({
      _id: 'token-id',
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      familyId: validFamilyId,
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    fixture.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).rejects.toThrow('轮换链写入冲突');
    expect(fixture.create).toHaveBeenCalledOnce();
  });

  it('持久化记录受损时在创建后继前失败关闭', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue({
      _id: 'token-id',
      tenantId: { $ne: null },
      actorId: 'actor-001',
      sessionId: 'session-001',
      familyId: validFamilyId,
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).rejects.toThrow('持久化状态非法');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['非法 family UUID', { familyId: 'family-001', generation: 0 }],
    ['轮换代数达到上限', { familyId: validFamilyId, generation: 1_000_000 }],
  ])('%s 时在创建后继前失败关闭', async (_name, persisted) => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue({
      _id: 'token-id',
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt: new Date(Date.now() + 60_000),
      ...persisted,
    });

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).rejects.toThrow('持久化状态非法');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.updateOne).not.toHaveBeenCalled();
  });

  it('已消费令牌重放时吊销整个 family 和服务端会话', async () => {
    const fixture = createFixture();
    fixture.findOneAndUpdate.mockResolvedValue(null);
    fixture.exec.mockResolvedValue({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      familyId: validFamilyId,
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      fixture.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).resolves.toEqual({ status: 'replay' });
    const replayCall = fixture.updateMany.mock.calls[0];
    expect(replayCall?.[0]).toEqual({
      tenantId: 'tenant-001',
      familyId: validFamilyId,
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

  it('非法预期客户端不查询数据库，受损重放记录不执行批量吊销', async () => {
    const invalidClient = createFixture();
    await expect(
      invalidClient.service.rotate(validRefreshToken, '$ne', mongoSession),
    ).resolves.toEqual({ status: 'invalid' });
    expect(invalidClient.findOneAndUpdate).not.toHaveBeenCalled();

    const damaged = createFixture();
    damaged.findOneAndUpdate.mockResolvedValue(null);
    damaged.exec.mockResolvedValue({
      tenantId: { $ne: null },
      actorId: 'actor-001',
      sessionId: 'session-001',
      familyId: validFamilyId,
      clientId: 'gaoq-web',
      generation: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      damaged.service.rotate(validRefreshToken, 'gaoq-web', mongoSession),
    ).rejects.toThrow('持久化状态非法');
    expect(damaged.updateMany).not.toHaveBeenCalled();
    expect(damaged.revoke).not.toHaveBeenCalled();
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

  it('会话级吊销拒绝非法租户或会话标识', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.revokeBySession('$where', 'session-001', mongoSession),
    ).rejects.toThrow('持久化状态非法');
    await expect(
      fixture.service.revokeBySession('tenant-001', 'bad session', mongoSession),
    ).rejects.toThrow('持久化状态非法');
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });
});
