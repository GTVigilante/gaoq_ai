import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import type { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { SessionController } from './session.controller.js';
import type { TokenGrantService } from './token-grant.service.js';

const verifiedAccessToken = {
  issuer: 'https://erp.example.com',
  subject: 'tenant-001:actor-001',
  audience: ['gaoq-erp'],
  resource: ['https://erp.example.com/mcp'],
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  actorType: 'user' as const,
  clientId: 'gaoq-web',
  roleCodes: ['employee'],
  scopes: ['erp:identity:profile:read'],
  departmentIds: ['department-001'],
  sessionId: 'session-001',
  expiresAt: Math.floor(Date.now() / 1_000) + 600,
};

const createFixture = () => {
  const revokeSession = vi.fn().mockResolvedValue(true);
  const clear = vi.fn();
  const recordTrustedUser = vi.fn().mockResolvedValue(undefined);
  const controller = new SessionController(
    { revokeSession } as unknown as TokenGrantService,
    { clear } as unknown as BrowserRefreshCookieService,
    { recordTrustedUser } as unknown as AuditService,
  );
  const request = {
    traceId: 'trace-session-001',
    verifiedAccessToken,
  } as unknown as ErpRequest;
  const response = {} as Response;
  return {
    controller,
    revokeSession,
    clear,
    recordTrustedUser,
    request,
    response,
  };
};

describe('SessionController', () => {
  it.each([
    [true, 'success'],
    [false, 'failure'],
  ])('只用验签令牌上下文吊销当前会话，结果 %s 记录 %s 审计', async (revoked, outcome) => {
    const fixture = createFixture();
    fixture.revokeSession.mockResolvedValueOnce(revoked);

    await expect(
      fixture.controller.revokeCurrent(fixture.request, fixture.response),
    ).resolves.toEqual({ revoked });
    expect(fixture.revokeSession).toHaveBeenCalledWith('tenant-001', 'session-001');
    expect(fixture.clear).toHaveBeenCalledWith(fixture.response);
    expect(fixture.recordTrustedUser).toHaveBeenCalledWith(
      'tenant-001',
      {
        actorId: 'actor-001',
        traceId: 'trace-session-001',
        action: 'identity.session.revoke',
        resourceType: 'identity_session',
        resourceId: 'session-001',
        riskLevel: 'R1',
        outcome,
      },
    );
  });

  it('缺少验签令牌时拒绝请求且不产生副作用', async () => {
    const fixture = createFixture();
    await expect(
      fixture.controller.revokeCurrent({} as ErpRequest, fixture.response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.revokeSession).not.toHaveBeenCalled();
    expect(fixture.clear).not.toHaveBeenCalled();
    expect(fixture.recordTrustedUser).not.toHaveBeenCalled();
  });

  it('业务提交后的审计故障被隔离，不把已吊销会话改写成失败', async () => {
    const fixture = createFixture();
    fixture.recordTrustedUser.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      fixture.controller.revokeCurrent(fixture.request, fixture.response),
    ).resolves.toEqual({ revoked: true });
    expect(fixture.clear).toHaveBeenCalledWith(fixture.response);
  });

  it('请求未携带 traceId 时生成新的可信审计追踪标识', async () => {
    const fixture = createFixture();
    delete fixture.request.traceId;

    await fixture.controller.revokeCurrent(fixture.request, fixture.response);

    const auditInput = fixture.recordTrustedUser.mock.calls[0]?.[1] as {
      readonly traceId: string;
    };
    expect(fixture.recordTrustedUser.mock.calls[0]?.[0]).toBe('tenant-001');
    expect(auditInput.traceId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it('吊销事务失败时不清 Cookie，也不记录错误终态审计', async () => {
    const fixture = createFixture();
    const failure = new Error('database unavailable');
    fixture.revokeSession.mockRejectedValueOnce(failure);

    await expect(
      fixture.controller.revokeCurrent(fixture.request, fixture.response),
    ).rejects.toBe(failure);
    expect(fixture.clear).not.toHaveBeenCalled();
    expect(fixture.recordTrustedUser).not.toHaveBeenCalled();
  });
});
