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
      externalTenantId: 'external-tenant-001',
    });
    expect(setStateCookie).toHaveBeenCalledWith(response, 'state-001');
  });

  it('无租户绑定时使用通用错误拒绝', async () => {
    const { controller, response } = createController(null);

    await expect(
      controller.start('dingtalk', { tenantSlug: 'unknown-tenant', returnPath: '/' }, response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('仓储返回的平台与请求不一致时失败关闭', async () => {
    const fixture = createController({
      tenantId: 'tenant-001',
      provider: 'dingtalk',
      externalTenantId: 'external-tenant-001',
    });
    await expect(fixture.controller.start(
      'feishu', { tenantSlug: 'gaoq-group', returnPath: '/' }, fixture.response,
    )).rejects.toThrow('SSO_TENANT_BINDING_CORRUPT');
    expect(fixture.issue).not.toHaveBeenCalled();
  });

  it('适配器配置失败时不向浏览器写入不可用 state Cookie', async () => {
    const fixture = createController({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
    });
    fixture.buildAuthorizationUrl.mockImplementation(() => {
      throw new Error('SSO_NOT_CONFIGURED');
    });
    await expect(fixture.controller.start(
      'feishu', { tenantSlug: 'gaoq-group', returnPath: '/' }, fixture.response,
    )).rejects.toThrow('SSO_NOT_CONFIGURED');
    expect(fixture.setStateCookie).not.toHaveBeenCalled();
  });

  it('在访问任何仓储前拒绝非白名单 provider', async () => {
    const { controller, resolveActive, response } = createController(null);

    await expect(
      controller.start('custom', { tenantSlug: 'gaoq-group', returnPath: '/' }, response),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveActive).not.toHaveBeenCalled();
  });

  it('允许已登记的 OP SSO provider 进入统一 state 与 PKCE 流程', async () => {
    const { controller, resolveActive, response } = createController({
      tenantId: 'tenant-001', provider: 'op', externalTenantId: 'op-tenant-001',
    });
    await expect(
      controller.start('op', { tenantSlug: 'gaoq-group', returnPath: '/' }, response),
    ).resolves.toMatchObject({ expiresIn: 300 });
    expect(resolveActive).toHaveBeenCalledWith('gaoq-group', 'op');
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

  it('Origin 拒绝或 provider 非法时仍清除浏览器 state Cookie', async () => {
    const originFixture = createController(null);
    originFixture.assertTrustedOrigin.mockImplementation(() => {
      throw new UnauthorizedException();
    });
    await expect(originFixture.controller.callback(
      'feishu',
      { state: 'state-001-long-enough', code: 'code-001' },
      originFixture.request,
      originFixture.response,
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(originFixture.assertBound).not.toHaveBeenCalled();
    expect(originFixture.clearStateCookie).toHaveBeenCalledWith(originFixture.response);

    const providerFixture = createController(null);
    await expect(providerFixture.controller.callback(
      'unknown',
      { state: 'state-001-long-enough', code: 'code-001' },
      providerFixture.request,
      providerFixture.response,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(providerFixture.issueFromSso).not.toHaveBeenCalled();
    expect(providerFixture.clearStateCookie).toHaveBeenCalledWith(providerFixture.response);
  });
});
