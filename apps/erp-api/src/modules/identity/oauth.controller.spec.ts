import type { ConfigService } from '@nestjs/config';
import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import type { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import type { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import type { OAuthClientCredentialsGrantService } from './oauth-client-credentials-grant.service.js';
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
  const issueClientCredentials = vi.fn().mockResolvedValue({
    accessToken: 'service-token', tokenType: 'Bearer', expiresIn: 600,
    scope: 'erp:mcp:server:connect',
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
    { issue: issueClientCredentials } as unknown as OAuthClientCredentialsGrantService,
    { resolveActive, assertRedirect } as unknown as OAuthClientRegistry,
    { assertAllowed } as unknown as OAuthRateLimitService,
    { assertTrustedOrigin, readRequired, set } as unknown as BrowserRefreshCookieService,
    { recordTrustedUser } as unknown as AuditService,
  );
  return {
    controller, begin, describe, decide, authenticateBrowserForOAuth, exchange, issueClientCredentials,
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

function authorizationCodeBody(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    grant_type: 'authorization_code',
    client_id: 'mcp-client-001',
    code: `oc_${'A'.repeat(43)}`,
    redirect_uri: 'https://claude.ai/callback',
    resource: 'https://erp.example.com/mcp',
    code_verifier: 'B'.repeat(43),
    ...overrides,
  };
}

function privateKeyAssertion(issuer = 'service-client-001'): string {
  return `e30.${Buffer.from(JSON.stringify({ iss: issuer })).toString('base64url')}.AA`;
}

describe('OAuthController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('client_credentials 接受 Basic 并返回标准令牌响应', async () => {
    const store = fixture();
    const response = responseFixture();
    const authorization = `Basic ${Buffer.from(`service-client-001:${'A'.repeat(43)}`).toString('base64')}`;

    await store.controller.token({
      grant_type: 'client_credentials', resource: 'https://erp.example.com/mcp',
      scope: 'erp:mcp:server:connect',
    }, publicRequest('trace-service-001', 'application/x-www-form-urlencoded', authorization), response.response);

    expect(store.issueClientCredentials).toHaveBeenCalledWith({
      authorization,
      resource: 'https://erp.example.com/mcp',
      scopes: ['erp:mcp:server:connect'],
      traceId: 'trace-service-001',
    });
    expect(response.json).toHaveBeenCalledWith({
      access_token: 'service-token', token_type: 'Bearer', expires_in: 600,
      scope: 'erp:mcp:server:connect',
    });
  });

  it('Basic 客户端认证失败返回 RFC 6749 要求的 401 challenge', async () => {
    const store = fixture();
    store.issueClientCredentials.mockRejectedValue(new HttpException({
      code: 'OAUTH_INVALID_CLIENT', message: '客户端认证失败',
    }, 401));
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'client_credentials', resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001', 'application/x-www-form-urlencoded',
      `Basic ${Buffer.from(`service-client-001:${'B'.repeat(43)}`).toString('base64')}`,
    ), response.response);

    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Basic realm="oauth-token"');
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_client' });
  });

  it('client_credentials 拒绝 Basic 与 private_key_jwt 混用', async () => {
    const store = fixture();
    const response = responseFixture();
    await store.controller.token({
      grant_type: 'client_credentials', resource: 'https://erp.example.com/mcp',
      client_id: 'service-client-001', client_assertion_type: 'urn:test', client_assertion: 'jwt',
    }, publicRequest(
      'trace-service-001', 'application/x-www-form-urlencoded', 'Basic invalid',
    ), response.response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_request' });
    expect(store.issueClientCredentials).not.toHaveBeenCalled();
  });

  it('authorize 对不支持的响应类型拒绝回显危险 state', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.authorize(
      'token', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-safe\r\nX-Injected: true', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://claude.ai/callback?error=unsupported_response_type&iss=http%3A%2F%2Flocalhost%3A3000',
    );
    expect(store.begin).not.toHaveBeenCalled();
  });

  it('authorize 未解析到活跃客户端时只返回本地错误', async () => {
    const store = fixture();
    store.resolveActive.mockReturnValue(undefined);
    const response = responseFixture();

    await store.controller.authorize(
      undefined, 'unknown-client', 'https://attacker.example/callback',
      undefined, undefined, undefined, undefined, undefined,
      publicRequest(), response.response,
    );

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_request' });
  });

  it('authorize 客户端级限流映射为临时错误并保留 503', async () => {
    const store = fixture();
    store.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HttpException({
        code: 'OAUTH_DEPENDENCY_UNAVAILABLE',
        message: '限流依赖不可用',
      }, 503));
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(store.assertAllowed).toHaveBeenNthCalledWith(2, 'authorize_client', 'mcp-client-001');
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://claude.ai/callback?error=temporarily_unavailable&state=state-001&iss=http%3A%2F%2Flocalhost%3A3000',
    );
  });

  it('authorize 对非协议异常保持失败传播', async () => {
    const store = fixture();
    const failure = new Error('rate limit storage failed');
    store.assertAllowed.mockRejectedValue(failure);

    await expect(store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), responseFixture().response,
    )).rejects.toBe(failure);
  });

  it.each([
    ['MCP_OAUTH_CLIENT_DISABLED', 'unauthorized_client'],
    ['MCP_OAUTH_STORE_UNAVAILABLE', 'temporarily_unavailable'],
    ['MCP_OAUTH_REQUEST_INVALID', 'invalid_request'],
  ])('authorize 将业务代码 %s 映射为 %s', async (code, oauthError) => {
    const store = fixture();
    store.begin.mockRejectedValue(new BadRequestException({ code, message: '授权请求失败' }));
    const response = responseFixture();

    await store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), response.response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      `https://claude.ai/callback?error=${oauthError}&state=state-001&iss=http%3A%2F%2Flocalhost%3A3000`,
    );
  });

  it('authorize 业务层非协议异常保持失败传播', async () => {
    const store = fixture();
    const failure = new Error('transaction storage failed');
    store.begin.mockRejectedValue(failure);

    await expect(store.controller.authorize(
      'code', 'mcp-client-001', 'https://claude.ai/callback',
      'erp:mcp:server:connect', 'state-001', 'A'.repeat(43), 'S256',
      'https://erp.example.com/mcp', publicRequest(), responseFixture().response,
    )).rejects.toBe(failure);
  });

  it('describe 返回最小授权请求描述，并统一隐藏协议异常', async () => {
    const successStore = fixture();
    const successResponse = responseFixture();
    await successStore.controller.describe('A'.repeat(43), successResponse.response);
    expect(successResponse.status).toHaveBeenCalledWith(200);
    expect(successResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      clientName: 'Claude',
      redirectOrigin: 'https://claude.ai',
    }));

    const failureStore = fixture();
    failureStore.describe.mockRejectedValue(new BadRequestException('expired'));
    const failureResponse = responseFixture();
    await failureStore.controller.describe('A'.repeat(43), failureResponse.response);
    expect(failureResponse.status).toHaveBeenCalledWith(400);
    expect(failureResponse.json).toHaveBeenCalledWith({ error: 'invalid_request' });
  });

  it('describe 对非协议异常保持失败传播', async () => {
    const store = fixture();
    const failure = new Error('transaction storage failed');
    store.describe.mockRejectedValue(failure);

    await expect(store.controller.describe(
      'A'.repeat(43),
      responseFixture().response,
    )).rejects.toBe(failure);
  });

  it('拒绝授权记录 denied 审计并返回事务重定向', async () => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.decide(
      'A'.repeat(43),
      { approved: false },
      publicRequest(),
      response.response,
    );

    expect(store.recordTrustedUser).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      resourceId: 'mcp-client-001',
      outcome: 'denied',
      metadata: { approved: false, scopeCount: 1 },
    }));
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('决策提交后的审计故障不反向改写成功终态', async () => {
    const store = fixture();
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = responseFixture();

    await store.controller.decide(
      'A'.repeat(43),
      { approved: true },
      publicRequest(),
      response.response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      redirect_to: 'https://claude.ai/callback?code=oc_value&state=state-001',
    });
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      code: 'OAUTH_DECISION_AUDIT_AFTER_COMMIT_FAILED',
      clientId: 'mcp-client-001',
    }));
  });

  it('决策失败且失败审计不可用时仍传播原始业务异常', async () => {
    const store = fixture();
    const failure = new BadRequestException({
      code: 'OAUTH_REQUEST_EXPIRED',
      message: '授权请求已过期',
    });
    store.decide.mockRejectedValue(failure);
    store.recordTrustedUser.mockRejectedValue(new Error('audit unavailable'));
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(store.controller.decide(
      'A'.repeat(43),
      { approved: true },
      publicRequest(undefined),
      responseFixture().response,
    )).rejects.toBe(failure);

    expect(store.recordTrustedUser).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      resourceId: 'unknown',
      outcome: 'failure',
      metadata: { approved: true },
    }));
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      code: 'OAUTH_DECISION_FAILURE_AUDIT_FAILED',
      clientId: 'unknown',
    }));
  });

  it.each([
    [null, 'invalid_request'],
    ['invalid', 'invalid_request'],
    [{ grant_type: 'refresh_token' }, 'unsupported_grant_type'],
    [authorizationCodeBody({ code_verifier: 'short' }), 'invalid_request'],
  ])('token 拒绝非法请求体 %#', async (body, expectedError) => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.token(body, publicRequest(), response.response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: expectedError });
    expect(store.exchange).not.toHaveBeenCalled();
  });

  it('token IP 限流返回 Retry-After，并对非协议异常保持传播', async () => {
    const limitedStore = fixture();
    limitedStore.assertAllowed.mockRejectedValue(new HttpException({
      code: 'OAUTH_RATE_LIMITED',
      message: '请求过于频繁',
      retryAfter: 23,
    }, 429));
    const limitedResponse = responseFixture();

    await limitedStore.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      limitedResponse.response,
    );
    expect(limitedResponse.setHeader).toHaveBeenCalledWith('Retry-After', '23');
    expect(limitedResponse.status).toHaveBeenCalledWith(429);
    expect(limitedResponse.json).toHaveBeenCalledWith({ error: 'temporarily_unavailable' });

    const failedStore = fixture();
    const failure = new Error('rate limit storage failed');
    failedStore.assertAllowed.mockRejectedValue(failure);
    await expect(failedStore.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      responseFixture().response,
    )).rejects.toBe(failure);
  });

  it('authorization_code 客户端限流与交换错误按 OAuth 语义映射', async () => {
    const limitedStore = fixture();
    limitedStore.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HttpException({
        code: 'OAUTH_RATE_LIMITED',
        message: '请求过于频繁',
      }, 429));
    const limitedResponse = responseFixture();

    await limitedStore.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      limitedResponse.response,
    );
    expect(limitedResponse.status).toHaveBeenCalledWith(429);
    expect(limitedResponse.json).toHaveBeenCalledWith({ error: 'temporarily_unavailable' });
    expect(limitedStore.exchange).not.toHaveBeenCalled();

    const grantStore = fixture();
    grantStore.exchange.mockRejectedValue(new BadRequestException({
      code: 'OAUTH_INVALID_GRANT',
      message: '授权码无效',
    }));
    const grantResponse = responseFixture();
    await grantStore.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      grantResponse.response,
    );
    expect(grantResponse.json).toHaveBeenCalledWith({ error: 'invalid_grant' });
  });

  it.each([
    ['OAUTH_SCOPE_INVALID', 'invalid_scope', 400],
    ['OAUTH_SIGNER_UNAVAILABLE', 'temporarily_unavailable', 503],
    ['OAUTH_REQUEST_INVALID', 'invalid_request', 400],
  ])('authorization_code 将 %s 映射为 %s', async (code, oauthError, status) => {
    const store = fixture();
    store.exchange.mockRejectedValue(new HttpException({ code, message: '交换失败' }, status));
    const response = responseFixture();

    await store.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      response.response,
    );

    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: oauthError });
  });

  it('authorization_code 交换非协议异常保持失败传播', async () => {
    const store = fixture();
    const failure = new Error('signer failed');
    store.exchange.mockRejectedValue(failure);

    await expect(store.controller.token(
      authorizationCodeBody(),
      publicRequest(),
      responseFixture().response,
    )).rejects.toBe(failure);
  });

  it('Basic 限流主体只能来自 Authorization，不能被请求体 client_id 欺骗', async () => {
    const store = fixture();
    const authorization = `Basic ${Buffer.from(`service-client-001:${'A'.repeat(43)}`).toString('base64')}`;

    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
      client_id: 'spoofed-client-001',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      authorization,
    ), responseFixture().response);

    expect(store.assertAllowed).toHaveBeenNthCalledWith(2, 'token_client', 'service-client-001');
    expect(store.issueClientCredentials).toHaveBeenCalledWith(expect.objectContaining({
      authorization,
      clientId: 'spoofed-client-001',
    }));
  });

  it('private_key_jwt 限流主体只能来自 assertion issuer，不能被请求体 client_id 欺骗', async () => {
    const store = fixture();
    const assertion = privateKeyAssertion();
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
      client_id: 'spoofed-client-001',
      scope: 'erp:mcp:server:connect erp:org:chart:read',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }, publicRequest('trace-service-002'), response.response);

    expect(store.assertAllowed).toHaveBeenNthCalledWith(2, 'token_client', 'service-client-001');
    expect(store.issueClientCredentials).toHaveBeenCalledWith({
      resource: 'https://erp.example.com/mcp',
      clientId: 'spoofed-client-001',
      scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      clientAssertion: assertion,
      traceId: 'trace-service-002',
    });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it.each([
    'Bearer token',
    'Basic',
  ])('client_credentials 拒绝非法认证头 %s', async (authorization) => {
    const store = fixture();
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      authorization,
    ), response.response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_request' });
    expect(store.assertAllowed).not.toHaveBeenCalledWith('token_client', expect.any(String));
  });

  it('client_credentials 缺失认证或 schema 非法时拒绝调用发证服务', async () => {
    const store = fixture();
    const missingResponse = responseFixture();
    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(), missingResponse.response);
    expect(missingResponse.json).toHaveBeenCalledWith({ error: 'invalid_request' });

    const invalidResponse = responseFixture();
    await store.controller.token({
      grant_type: 'client_credentials',
      resource: '',
      extra: true,
    }, publicRequest(), invalidResponse.response);
    expect(invalidResponse.json).toHaveBeenCalledWith({ error: 'invalid_request' });
    expect(store.issueClientCredentials).not.toHaveBeenCalled();
  });

  it('client_credentials 限流按 Basic 认证语义返回错误', async () => {
    const store = fixture();
    store.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HttpException({
        code: 'OAUTH_INVALID_CLIENT',
        message: '客户端认证失败',
      }, 401));
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      `Basic ${Buffer.from(`service-client-001:${'A'.repeat(43)}`).toString('base64')}`,
    ), response.response);

    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Basic realm="oauth-token"');
    expect(response.status).toHaveBeenCalledWith(401);
    expect(store.issueClientCredentials).not.toHaveBeenCalled();
  });

  it('private_key_jwt 发证失败不返回 Basic challenge', async () => {
    const store = fixture();
    store.issueClientCredentials.mockRejectedValue(new HttpException({
      code: 'OAUTH_INVALID_CLIENT',
      message: '客户端认证失败',
    }, 401));
    const response = responseFixture();

    await store.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
      client_id: 'service-client-001',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: privateKeyAssertion(),
    }, publicRequest(), response.response);

    expect(response.setHeader).not.toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Basic realm="oauth-token"',
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_client' });
  });

  it('client_credentials 发证和限流非协议异常保持失败传播', async () => {
    const authorization = `Basic ${Buffer.from(`service-client-001:${'A'.repeat(43)}`).toString('base64')}`;
    const rateStore = fixture();
    const rateFailure = new Error('rate limit storage failed');
    rateStore.assertAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rateFailure);
    await expect(rateStore.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      authorization,
    ), responseFixture().response)).rejects.toBe(rateFailure);

    const issueStore = fixture();
    const issueFailure = new Error('signer failed');
    issueStore.issueClientCredentials.mockRejectedValue(issueFailure);
    await expect(issueStore.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      authorization,
    ), responseFixture().response)).rejects.toBe(issueFailure);
  });

  it('畸形认证材料统一进入 unknown 限流桶', async () => {
    const malformedBasicStore = fixture();
    await malformedBasicStore.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
    }, publicRequest(
      'trace-service-001',
      'application/x-www-form-urlencoded',
      'Basic bm9jb2xvbg==',
    ), responseFixture().response);
    expect(malformedBasicStore.assertAllowed).toHaveBeenNthCalledWith(2, 'token_client', 'unknown');

    const malformedJwtStore = fixture();
    await malformedJwtStore.controller.token({
      grant_type: 'client_credentials',
      resource: 'https://erp.example.com/mcp',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'not-a-jwt',
    }, publicRequest(), responseFixture().response);
    expect(malformedJwtStore.assertAllowed).toHaveBeenNthCalledWith(2, 'token_client', 'unknown');
  });

  it('请求地址依次回退到 socket 和 unknown', async () => {
    const socketStore = fixture();
    const socketRequest = {
      traceId: 'trace-socket',
      ip: '',
      socket: { remoteAddress: '10.0.0.8' },
      is: vi.fn().mockReturnValue(false),
      header: vi.fn(),
    } as unknown as ErpRequest;
    await socketStore.controller.token({}, socketRequest, responseFixture().response);
    expect(socketStore.assertAllowed).toHaveBeenNthCalledWith(1, 'token_ip', '10.0.0.8');

    const unknownStore = fixture();
    const unknownRequest = {
      traceId: 'trace-unknown',
      ip: '',
      socket: {},
      is: vi.fn().mockReturnValue(false),
      header: vi.fn(),
    } as unknown as ErpRequest;
    await unknownStore.controller.token({}, unknownRequest, responseFixture().response);
    expect(unknownStore.assertAllowed).toHaveBeenNthCalledWith(1, 'token_ip', 'unknown');
  });
});
