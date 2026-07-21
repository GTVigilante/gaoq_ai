import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SsoAdapterRegistry } from './sso-adapter.js';
import type { SsoStateService } from './sso-state.service.js';
import type { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';
import { SsoController } from './sso.controller.js';
import type { TokenGrantService } from './token-grant.service.js';
import type { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import type { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';
import type { Request, Response } from 'express';

const createController = (binding: object | null) => {
  const resolveActive = vi.fn().mockResolvedValue(binding);
  const bindings = { resolveActive };
  const issue = vi.fn().mockResolvedValue({ state: 'state-001', codeChallenge: 'challenge-001' });
  const states = {
    issue,
  };
  const buildAuthorizationUrl = vi
    .fn()
    .mockReturnValue('https://accounts.example/authorize?state=state-001');
  const adapter = {
    buildAuthorizationUrl,
  };
  const adapters = { get: vi.fn().mockReturnValue(adapter) };
  const issueFromSso = vi.fn();
  const grants = { issueFromSso };
  const assertTrustedOrigin = vi.fn();
  const setCookie = vi.fn();
  const cookies = { assertTrustedOrigin, set: setCookie };
  const setStateCookie = vi.fn();
  const assertBound = vi.fn();
  const clearStateCookie = vi.fn();
  const stateCookie = { set: setStateCookie, assertBound, clear: clearStateCookie };
  const response = {} as Response;
  const request = {} as Request;
  return {
    controller: new SsoController(
      bindings as unknown as SsoTenantBindingRepository,
      states as unknown as SsoStateService,
      adapters as unknown as SsoAdapterRegistry,
      grants as unknown as TokenGrantService,
      cookies as unknown as BrowserRefreshCookieService,
      stateCookie as unknown as BrowserSsoStateCookieService,
    ),
    resolveActive,
    issue,
    buildAuthorizationUrl,
    issueFromSso,
    assertTrustedOrigin,
    setCookie,
    setStateCookie,
    assertBound,
    clearStateCookie,
    response,
    request,
  };
};

describe('SsoController', () => {
  it('租户解析后签发 state 并生成固定供应商授权地址', async () => {
    const { controller, issue, buildAuthorizationUrl, setStateCookie, response } = createController({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
    });

    await expect(
      controller.start('feishu', { tenantSlug: 'gaoq-group', returnPath: '/workspace' }, response),
    ).resolves.toEqual({
      authorizationUrl: 'https://accounts.example/authorize?state=state-001',
      expiresIn: 300,
    });
    expect(issue).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
      returnPath: '/workspace',
    });
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({
      state: 'state-001',
      codeChallenge: 'challenge-001',
    });
    expect(setStateCookie).toHaveBeenCalledWith(response, 'state-001');
  });

  it('无租户绑定时使用通用错误拒绝', async () => {
    const { controller, response } = createController(null);

    await expect(
      controller.start('dingtalk', { tenantSlug: 'unknown-tenant', returnPath: '/' }, response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('在访问任何仓储前拒绝非白名单 provider', async () => {
    const { controller, resolveActive, response } = createController(null);

    await expect(
      controller.start('custom', { tenantSlug: 'gaoq-group', returnPath: '/' }, response),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveActive).not.toHaveBeenCalled();
  });

  it('回调验证浏览器 state 绑定并只把刷新令牌写入 Cookie', async () => {
    const {
      controller,
      issueFromSso,
      assertTrustedOrigin,
      assertBound,
      clearStateCookie,
      setCookie,
      request,
      response,
    } = createController(null);
    issueFromSso.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: `rt_${'A'.repeat(64)}`,
      tokenType: 'Bearer',
      expiresIn: 600,
      scope: 'erp:identity:profile:read',
      returnPath: '/workspace',
    });

    const result = await controller.callback(
      'feishu',
      { state: 'state-001-long-enough', code: 'code-001' },
      request,
      response,
    );

    expect(assertTrustedOrigin).toHaveBeenCalledWith(request);
    expect(assertBound).toHaveBeenCalledWith(request, 'state-001-long-enough');
    expect(setCookie).toHaveBeenCalledWith(response, `rt_${'A'.repeat(64)}`);
    expect(clearStateCookie).toHaveBeenCalledWith(response);
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('SSO 回调失败时仍清除浏览器 state Cookie', async () => {
    const { controller, issueFromSso, clearStateCookie, request, response } = createController(null);
    issueFromSso.mockRejectedValue(new Error('上游失败'));

    await expect(
      controller.callback(
        'dingtalk',
        { state: 'state-001-long-enough', code: 'code-001' },
        request,
        response,
      ),
    ).rejects.toThrow('上游失败');
    expect(clearStateCookie).toHaveBeenCalledWith(response);
  });
});
