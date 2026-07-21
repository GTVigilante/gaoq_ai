import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AccessProfileRepository } from './access-profile.repository.js';
import type { ExternalIdentityRepository } from './external-identity.repository.js';
import { IdentityLifecycleService } from './identity-lifecycle.service.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import type { SessionService } from './session.service.js';

const mongoSession = {} as ClientSession;

const fixture = () => {
  const profiles = {
    findActorIdByEmployee: vi.fn().mockResolvedValue('actor-profile'),
    disableByEmployee: vi.fn().mockResolvedValue(true),
  };
  const external = {
    findActorIdsByEmployee: vi.fn().mockResolvedValue(Object.freeze([
      'actor-profile', 'actor-external',
    ])),
    disableAllByEmployee: vi.fn().mockResolvedValue(2),
  };
  const refresh = { revokeAllByActors: vi.fn().mockResolvedValue(4) };
  const sessions = { revokeAllByActors: vi.fn().mockResolvedValue(3) };
  const service = new IdentityLifecycleService(
    profiles as unknown as AccessProfileRepository,
    external as unknown as ExternalIdentityRepository,
    refresh as unknown as RefreshTokenService,
    sessions as unknown as SessionService,
  );
  return { service, profiles, external, refresh, sessions };
};

describe('IdentityLifecycleService', () => {
  it('同一事务内去重主体并完成授权、绑定、刷新令牌与会话封禁', async () => {
    const store = fixture();
    const result = await store.service.terminateEmployee(
      'tenant-001',
      'employee-001',
      mongoSession,
    );
    expect(result).toEqual({
      actorIds: ['actor-external', 'actor-profile'],
      accessProfileDisabled: true,
      externalIdentitiesDisabled: 2,
      sessionsRevoked: 3,
      refreshTokensRevoked: 4,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.actorIds)).toBe(true);
    for (const dependency of [
      store.profiles.findActorIdByEmployee,
      store.external.findActorIdsByEmployee,
      store.profiles.disableByEmployee,
      store.external.disableAllByEmployee,
      store.refresh.revokeAllByActors,
      store.sessions.revokeAllByActors,
    ]) expect(dependency).toHaveBeenCalledWith(
      'tenant-001',
      expect.anything(),
      mongoSession,
    );
    expect(store.refresh.revokeAllByActors).toHaveBeenCalledWith(
      'tenant-001',
      ['actor-external', 'actor-profile'],
      mongoSession,
    );
  });

  it('员工尚无任何身份时仍停用可能存在的记录，但不执行空数组批量吊销', async () => {
    const store = fixture();
    store.profiles.findActorIdByEmployee.mockResolvedValue(null);
    store.external.findActorIdsByEmployee.mockResolvedValue(Object.freeze([]));
    const result = await store.service.terminateEmployee('tenant-001', 'employee-001', mongoSession);
    expect(result.actorIds).toEqual([]);
    expect(store.profiles.disableByEmployee).toHaveBeenCalled();
    expect(store.external.disableAllByEmployee).toHaveBeenCalled();
    expect(store.refresh.revokeAllByActors).not.toHaveBeenCalled();
    expect(store.sessions.revokeAllByActors).not.toHaveBeenCalled();
  });

  it('非法租户或员工标识在访问仓储前失败关闭且不回显输入', async () => {
    const store = fixture();
    const error = await store.service.terminateEmployee('$where', 'employee-001', mongoSession)
      .catch((reason: unknown) => reason);
    expect(String(error)).toContain('标识非法');
    expect(String(error)).not.toContain('$where');
    expect(store.profiles.findActorIdByEmployee).not.toHaveBeenCalled();
  });
});
