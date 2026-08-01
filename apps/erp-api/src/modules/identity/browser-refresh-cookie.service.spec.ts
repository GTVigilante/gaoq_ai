import type { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';

const createService = (nodeEnv: 'development' | 'production' = 'production') =>
  new BrowserRefreshCookieService(
    {
      get: (key: string): string | number | undefined => ({
        NODE_ENV: nodeEnv,
        WEB_ORIGIN: 'https://erp.example.com',
        AUTH_REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
      })[key],
    } as unknown as ConfigService<AppEnvironment, true>,
  );

const createRequest = (headers: Readonly<Record<string, string | undefined>>): Request =>
  ({ header: (name: string): string | undefined => headers[name.toLowerCase()] }) as unknown as Request;

describe('BrowserRefreshCookieService', () => {
  it('生产环境使用 __Host、Secure、HttpOnly 与 SameSite Strict', () => {
    const cookie = vi.fn();
    const response = { cookie } as unknown as Response;
    const token = `rt_${'A'.repeat(64)}`;

    createService().set(response, token);

    expect(cookie).toHaveBeenCalledWith('__Host-gaoq_refresh', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 2_592_000_000,
    });
  });

  it('开发环境使用非 __Host Cookie，清理属性与设置属性保持一致', () => {
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const response = { cookie, clearCookie } as unknown as Response;
    const service = createService('development');
    const token = `rt_${'A'.repeat(64)}`;

    service.set(response, token);
    service.clear(response);

    expect(cookie).toHaveBeenCalledWith(
      'gaoq_refresh',
      token,
      expect.objectContaining({ secure: false }),
    );
    expect(clearCookie).toHaveBeenCalledWith('gaoq_refresh', {
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('禁止把内部受损的刷新令牌写入 Cookie', () => {
    const cookie = vi.fn();
    expect(() => createService().set({ cookie } as unknown as Response, 'invalid'))
      .toThrow('刷新令牌格式非法');
    expect(cookie).not.toHaveBeenCalled();
  });

  it('刷新请求必须来自精确 WEB_ORIGIN', () => {
    const service = createService();

    expect(() => service.assertTrustedOrigin(createRequest({ origin: 'https://erp.example.com' })))
      .not.toThrow();
    expect(() => service.assertTrustedOrigin(createRequest({ origin: 'https://evil.example' })))
      .toThrow(ForbiddenException);
  });

  it('只读取固定名称且格式正确的刷新 Cookie', () => {
    const service = createService();
    const token = `rt_${'A'.repeat(64)}`;

    expect(
      service.readRequired(createRequest({ cookie: `other=x; __Host-gaoq_refresh=${token}` })),
    ).toBe(token);
    expect(() =>
      service.readRequired(createRequest({ cookie: '__Host-gaoq_refresh=attacker' })),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    ['缺失', undefined],
    [
      '重复',
      `__Host-gaoq_refresh=rt_${'A'.repeat(64)}; __Host-gaoq_refresh=rt_${'B'.repeat(64)}`,
    ],
    ['超长', `other=${'A'.repeat(8_193)}`],
  ])('拒绝%s刷新 Cookie，避免 Cookie tossing 与超长头歧义', (_name, cookie) => {
    expect(() => createService().readRequired(createRequest({ cookie })))
      .toThrow(UnauthorizedException);
  });
});
