import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientSession, Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AccessProfileRepository } from './access-profile.repository.js';
import type { AccessTokenSigner } from './access-token-signer.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import type { SessionService } from './session.service.js';
import type { SsoAuthenticationService } from './sso-authentication.service.js';
import { TokenGrantService } from './token-grant.service.js';

const mongoSession = {} as ClientSession;
const profile = Object.freeze({
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
  status: 'active' as const,
  roleCodes: Object.freeze(['employee']),
  scopes: Object.freeze(['erp:mcp:server:connect', 'erp:identity:profile:read']),
  departmentIds: Object.freeze(['department-001']),
  version: 1,
});

const createFixture = () => {
  const transaction = vi.fn(async (work: (session: ClientSession) => Promise<unknown>) =>
    work(mongoSession),
  );
  const verifyAuthorizationCode = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001',
    actorId: 'actor-001',
    employeeId: 'employee-001',
    provider: 'feishu',
    returnPath: '/workspace',
  });
  const resolveActive = vi.fn().mockResolvedValue(profile);
  const open = vi.fn().mockResolvedValue(undefined);
  const isActive = vi.fn().mockResolvedValue(true);
  const revoke = vi.fn().mockResolvedValue(true);
  const issueInitial = vi.fn().mockResolvedValue({
    refreshToken: `rt_${'A'.repeat(64)}`,
    familyId: 'family-001',
  });
  const rotate = vi.fn();
  const revokeBySession = vi.fn().mockResolvedValue(undefined);
  const sign = vi.fn().mockResolvedValue({
    accessToken: 'signed-access-token',
    tokenType: 'Bearer',
    expiresIn: 600,
  });
  const config = {
    get: (key: string): number | undefined =>
      key === 'AUTH_REFRESH_TOKEN_TTL_SECONDS' ? 2_592_000 : undefined,
  } as unknown as ConfigService<AppEnvironment, true>;
  const service = new TokenGrantService(
    { transaction } as unknown as Connection,
    config,
    { verifyAuthorizationCode } as unknown as SsoAuthenticationService,
    { resolveActive } as unknown as AccessProfileRepository,
    { open, isActive, revoke } as unknown as SessionService,
    { issueInitial, rotate, revokeBySession } as unknown as RefreshTokenService,
    { sign } as unknown as AccessTokenSigner,
  );
  return {
    service,
    transaction,
    verifyAuthorizationCode,
    resolveActive,
    open,
    isActive,
    revoke,
    issueInitial,
    rotate,
    revokeBySession,
    sign,
  };
};

describe('TokenGrantService', () => {
  it('SSO 映射、授权快照、会话与刷新令牌形成完整事务链', async () => {
    const fixture = createFixture();

    const grant = await fixture.service.issueFromSso({
      provider: 'feishu',
      state: 'state-001',
      code: 'code-001',
    });

    expect(grant).toMatchObject({
      accessToken: 'signed-access-token',
      refreshToken: `rt_${'A'.repeat(64)}`,
      scope: 'erp:mcp:server:connect erp:identity:profile:read',
      returnPath: '/workspace',
    });
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.open.mock.calls[0]?.[1]).toBe(mongoSession);
    expect(fixture.issueInitial.mock.calls[0]?.[1]).toBe(mongoSession);
    expect(fixture.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        clientId: 'gaoq-web',
        roleCodes: ['employee'],
      }),
    );
  });

  it('外部身份与授权快照员工不一致时失败关闭', async () => {
    const fixture = createFixture();
    fixture.resolveActive.mockResolvedValue({ ...profile, employeeId: 'another-employee' });

    await expect(
      fixture.service.issueFromSso({ provider: 'feishu', state: 'state-001', code: 'code-001' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('刷新令牌重放结果先提交吊销事务，再返回统一 invalid_grant', async () => {
    const fixture = createFixture();
    fixture.rotate.mockResolvedValue({ status: 'replay' });

    await expect(fixture.service.refresh(`rt_${'A'.repeat(64)}`)).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_GRANT' },
    });
    expect(fixture.transaction).toHaveBeenCalledOnce();
    expect(fixture.sign).not.toHaveBeenCalled();
  });

  it('轮换事务内重新读取权限并签发新访问令牌', async () => {
    const fixture = createFixture();
    fixture.rotate.mockResolvedValue({
      status: 'rotated',
      refreshToken: `rt_${'B'.repeat(64)}`,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(fixture.service.refresh(`rt_${'A'.repeat(64)}`)).resolves.toMatchObject({
      accessToken: 'signed-access-token',
      refreshToken: `rt_${'B'.repeat(64)}`,
      scope: 'erp:mcp:server:connect erp:identity:profile:read',
    });
    expect(fixture.resolveActive).toHaveBeenCalledWith(
      'tenant-001',
      'actor-001',
      mongoSession,
    );
    expect(fixture.sign).toHaveBeenCalledOnce();
  });

  it('OAuth 同意只从轮换后的可信浏览器会话取得租户与权限快照', async () => {
    const fixture = createFixture();
    fixture.rotate.mockResolvedValue({
      status: 'rotated',
      refreshToken: `rt_${'B'.repeat(64)}`,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const identity = await fixture.service.authenticateBrowserForOAuth(`rt_${'A'.repeat(64)}`);

    expect(identity).toEqual({
      refreshToken: `rt_${'B'.repeat(64)}`,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      roleCodes: ['employee'],
      scopes: ['erp:mcp:server:connect', 'erp:identity:profile:read'],
      departmentIds: ['department-001'],
    });
    expect(fixture.sign).not.toHaveBeenCalled();
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.scopes)).toBe(true);
  });

  it('会话或权限停用时在事务内吊销新 family，不签发访问令牌', async () => {
    const fixture = createFixture();
    fixture.rotate.mockResolvedValue({
      status: 'rotated',
      refreshToken: `rt_${'B'.repeat(64)}`,
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      expiresAt: new Date(Date.now() + 60_000),
    });
    fixture.resolveActive.mockResolvedValue(null);

    await expect(fixture.service.refresh(`rt_${'A'.repeat(64)}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fixture.revokeBySession).toHaveBeenCalledWith(
      'tenant-001',
      'session-001',
      mongoSession,
    );
    expect(fixture.revoke).toHaveBeenCalledWith('tenant-001', 'session-001', mongoSession);
    expect(fixture.sign).not.toHaveBeenCalled();
  });
});
