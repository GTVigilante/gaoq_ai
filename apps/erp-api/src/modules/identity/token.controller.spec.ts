import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import type { TokenGrantService } from './token-grant.service.js';
import { TokenController } from './token.controller.js';

const createFixture = () => {
  const assertTrustedOrigin = vi.fn();
  const readRequired = vi.fn().mockReturnValue(`rt_${'A'.repeat(64)}`);
  const set = vi.fn();
  const clear = vi.fn();
  const refresh = vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    tokenType: 'Bearer',
    expiresIn: 600,
    refreshToken: `rt_${'B'.repeat(64)}`,
    scope: 'erp:identity:profile:read',
    returnPath: '/',
  });
  const controller = new TokenController(
    { refresh } as unknown as TokenGrantService,
    { assertTrustedOrigin, readRequired, set, clear } as unknown as BrowserRefreshCookieService,
  );
  return {
    controller,
    assertTrustedOrigin,
    readRequired,
    set,
    clear,
    refresh,
    request: {} as Request,
    response: {} as Response,
  };
};

describe('TokenController', () => {
  it('校验来源并原子轮换 Cookie，只返回短期访问令牌最小投影', async () => {
    const fixture = createFixture();

    await expect(
      fixture.controller.refresh(fixture.request, fixture.response),
    ).resolves.toEqual({
      accessToken: 'access-token',
      tokenType: 'Bearer',
      expiresIn: 600,
      scope: 'erp:identity:profile:read',
    });
    expect(fixture.assertTrustedOrigin).toHaveBeenCalledWith(fixture.request);
    expect(fixture.refresh).toHaveBeenCalledWith(`rt_${'A'.repeat(64)}`);
    expect(fixture.set).toHaveBeenCalledWith(fixture.response, `rt_${'B'.repeat(64)}`);
  });

  it('刷新令牌失效时清理 Cookie，基础设施异常时保留 Cookie 供安全重试', async () => {
    const invalid = createFixture();
    invalid.refresh.mockRejectedValueOnce(new UnauthorizedException({
      code: 'AUTH_INVALID_GRANT',
      message: '登录凭据无效或已失效',
    }));
    await expect(invalid.controller.refresh(invalid.request, invalid.response))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(invalid.clear).toHaveBeenCalledWith(invalid.response);
    expect(invalid.set).not.toHaveBeenCalled();

    const unavailable = createFixture();
    const failure = new Error('database unavailable');
    unavailable.refresh.mockRejectedValueOnce(failure);
    await expect(unavailable.controller.refresh(unavailable.request, unavailable.response))
      .rejects.toBe(failure);
    expect(unavailable.clear).not.toHaveBeenCalled();
  });

  it('来源校验失败时不读取 Cookie 或调用令牌服务', async () => {
    const fixture = createFixture();
    fixture.assertTrustedOrigin.mockImplementationOnce(() => {
      throw new Error('origin denied');
    });

    await expect(fixture.controller.refresh(fixture.request, fixture.response))
      .rejects.toThrow('origin denied');
    expect(fixture.readRequired).not.toHaveBeenCalled();
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
});
