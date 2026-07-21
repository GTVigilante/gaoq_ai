import type { ConfigService } from '@nestjs/config';
import { BadRequestException, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import type { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import type { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import type { OAuthClientRegistry } from './oauth-client-registry.js';
import { OAuthController } from './oauth.controller.js';
import type { OAuthRateLimitService } from './oauth-rate-limit.service.js';
import type { OAuthTokenGrantService } from './oauth-token-grant.service.js';
import type { TokenGrantService } from './token-grant.service.js';

function responseFixture() {
  const status = vi.fn();
  const json = vi.fn();
  const redirect = vi.fn();
  const setHeader = vi.fn();
  const response = { status, json, redirect, setHeader } as unknown as Response;
  status.mockReturnValue(response);
  return { response, status, json, redirect, setHeader };
}

function fixture() {
  const begin = vi.fn().mockResolvedValue({ requestId: 'A'.repeat(43) });
  const describe = vi.fn().mockResolvedValue({
    requestId: 'A'.repeat(43), clientName: 'Claude',
    redirectOrigin: 'https://claude.ai', scopes: ['erp:mcp:server:connect'], expiresIn: 600,
  });
  const decide = vi.fn().mockResolvedValue({
    redirectTo: 'https://claude.ai/callback?code=oc_value&state=state-001',
    clientId: 'mcp-client-001', scopes: ['erp:mcp:server:connect'],
  });
  const authenticateBrowserForOAuth = vi.fn().mockResolvedValue({
    refreshToken: `rt_${'B'.repeat(64)}`,
    tenantId: 'tenant-001', actorId: 'actor-001', sessionId: 'session-001',
    roleCodes: ['employee'], scopes: ['erp:mcp:server:connect'], departmentIds: ['department-001'],
  });
  const exchange = vi.fn().mockResolvedValue({
    accessToken: 'signed-token', tokenType: 'Bearer', expiresIn: 600, scope: 'erp:mcp:server:connect',
  });
  const resolveActive = vi.fn().mockReturnValue({
    clientId: 'mcp-client-001', redirectUris: ['https://claude.ai/callback'],
  });
  const assertRedirect = vi.fn().mockImplementation(
    (client: { redirectUris: readonly string[] }, redirectUri: string) => {
      if (!client.redirectUris.includes(redirectUri)) throw new Error('redirect denied');
    },
  );
  const assertAllowed = vi.fn().mockResolvedValue(undefined);
  const assertTrustedOrigin = vi.fn();
  const readRequired = vi.fn().mockReturnValue(`rt_${'A'.repeat(64)}`);
  const set = vi.fn();
  const recordTrustedUser = vi.fn().mockResolvedValue(undefined);
  const controller = new OAuthController(
    { get: () => 'http://localhost:3000' } as unknown as ConfigService<AppEnvironment, true>,
    { begin, describe, decide } as unknown as OAuthAuthorizationTransactionService,
    { authenticateBrowserForOAuth } as unknown as TokenGrantService,
    { exchange } as unknown as OAuthTokenGrantService,
    { resolveActive, assertRedirect } as unknown as OAuthClientRegistry,
    { assertAllowed } as unknown as OAuthRateLimitService,
    { assertTrustedOrigin, readRequired, set } as unknown as BrowserRefreshCookieService,
    { recordTrustedUser } as unknown as AuditService,
  );
  return {
    controller, begin, describe, decide, authenticateBrowserForOAuth, exchange,
    resolveActive, assertRedirect, assertAllowed, assertTrustedOrigin, readRequired, set,
    recordTrustedUser,
  };
}

const publicRequest = (
  traceId = 'trace-oauth-001',
  mediaType: string | false = 'application/x-www-form-urlencoded',
  authorization?: string,
) => ({
  traceId,
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  is: vi.fn().mockReturnValue(mediaType),
  header: vi.fn().mockReturnValue(authorization),
}) as unknown as ErpRequest;

describe('OAuthController', () => {
  it('标准 authorize 请求创建短时请求并跳转 ERP 同意页', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect erp:org:chart:read', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(store.begin).toHaveBeenCalledWith({
      clientId: 'mcp-client-001', redirectUri: 'https://claude.ai/callback',
      scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'], state: 'state-001',
      codeChallenge: 'A'.repeat(43), resource: 'https://erp.example.com/mcp',
    });
    expect(response.redirect).toHaveBeenCalledWith(
      302, `http://localhost:3000/oauth/consent?request_id=${'A'.repeat(43)}`,
    );
  });

  it('缺失 PKCE S256 或 resource 时返回 OAuth invalid_request', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', undefined, 'plain', undefined,
      publicRequest(), response.response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://claude.ai/callback?error=invalid_request&state=state-001&iss=http%3A%2F%2Flocalhost%3A3000',
    );
    expect(store.begin).not.toHaveBeenCalled();
  });

  it('authorize 校验失败仅向预注册回调返回 error、state 与 iss', async () => {
    const store = fixture();
    store.begin.mockRejectedValue(new BadRequestException({
      code: 'MCP_OAUTH_SCOPE_INVALID', message: 'scope 非法',
    }));
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:org:chart:read', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://claude.ai/callback?error=invalid_scope&state=state-001&iss=http%3A%2F%2Flocalhost%3A3000',
    );
  });

  it('未注册回调失败时禁止重定向', async () => {
    const store = fixture();
    store.begin.mockRejectedValue(new BadRequestException({
      code: 'MCP_OAUTH_REDIRECT_URI_DENIED', message: 'redirect 非法',
    }));
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://attacker.example/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it('同意决策轮换 HttpOnly Cookie、使用可信租户并记录 R1 审计', async () => {
    const store = fixture();
    const response = responseFixture();
    const request = {
      traceId: 'trace-oauth-001',
      header: vi.fn().mockImplementation((name: string) => name === 'origin'
        ? 'http://localhost:3000'
        : undefined),
    } as unknown as ErpRequest;

    await store.controller.decide('A'.repeat(43), { approved: true }, request, response.response);

    expect(store.assertTrustedOrigin).toHaveBeenCalledWith(request);
    expect(store.set).toHaveBeenCalledWith(response.response, `rt_${'B'.repeat(64)}`);
    expect(store.decide).toHaveBeenCalledWith(
      'A'.repeat(43), true, expect.objectContaining({ tenantId: 'tenant-001' }),
    );
    expect(store.recordTrustedUser).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      actorId: 'actor-001', resourceId: 'mcp-client-001', riskLevel: 'R1', outcome: 'success',
    }));
    expect(response.json).toHaveBeenCalledWith({
      redirect_to: 'https://claude.ai/callback?code=oc_value&state=state-001',
    });
  });

  it('同意决策防御性拒绝字符串布尔值', async () => {
    const store = fixture();
    const response = responseFixture();

    await expect(store.controller.decide(
      'A'.repeat(43),
      { approved: 'false' } as unknown as { approved: boolean },
      publicRequest(),
      response.response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.authenticateBrowserForOAuth).not.toHaveBeenCalled();
  });

  it('authorize 超限返回 Retry-After，且只向可信回调返回临时错误', async () => {
    const store = fixture();
    store.assertAllowed.mockRejectedValueOnce(new HttpException({
      code: 'OAUTH_RATE_LIMITED', message: '请求过于频繁', retryAfter: 17,
    }, 429));
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '17');
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://claude.ai/callback?error=temporarily_unavailable&state=state-001&iss=http%3A%2F%2Flocalhost%3A3000',
    );
    expect(store.begin).not.toHaveBeenCalled();
  });

  it('token endpoint 仅接受 authorization_code 并返回标准 snake_case 响应', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'authorization_code', client_id: 'mcp-client-001',
      code: `oc_${'A'.repeat(43)}`, redirect_uri: 'https://claude.ai/callback',
      resource: 'https://erp.example.com/mcp', code_verifier: 'B'.repeat(43),
    }, publicRequest('trace-token-001'), response.response);

    expect(store.exchange).toHaveBeenCalledWith({
      code: `oc_${'A'.repeat(43)}`, clientId: 'mcp-client-001',
      redirectUri: 'https://claude.ai/callback', resource: 'https://erp.example.com/mcp',
      codeVerifier: 'B'.repeat(43), traceId: 'trace-token-001',
    });
    expect(response.json).toHaveBeenCalledWith({
      access_token: 'signed-token', token_type: 'Bearer', expires_in: 600,
      scope: 'erp:mcp:server:connect',
    });
  });

  it('token endpoint 拒绝 JSON 请求和客户端 Basic 凭据混入', async () => {
    const store = fixture();
    const response = responseFixture();
    const body = {
      grant_type: 'authorization_code', client_id: 'mcp-client-001',
      code: `oc_${'A'.repeat(43)}`, redirect_uri: 'https://claude.ai/callback',
      resource: 'https://erp.example.com/mcp', code_verifier: 'B'.repeat(43),
    };

    const jsonRequest = publicRequest('trace-oauth-001', false);
    await store.controller.token(body, jsonRequest, response.response);
    expect(response.json).toHaveBeenLastCalledWith({ error: 'invalid_request' });

    const basicRequest = publicRequest(
      'trace-oauth-001',
      'application/x-www-form-urlencoded',
      'Basic unexpected',
    );
    await store.controller.token(body, basicRequest, response.response);
    expect(response.json).toHaveBeenLastCalledWith({ error: 'invalid_request' });
    expect(store.exchange).not.toHaveBeenCalled();
  });
});
