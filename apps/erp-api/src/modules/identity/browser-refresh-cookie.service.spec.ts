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
});
