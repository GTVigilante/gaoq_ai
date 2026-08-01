import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';

const createService = (environment = 'production') =>
  new BrowserSsoStateCookieService(
    {
      get: (key: string): string | undefined =>
        key === 'NODE_ENV' ? environment : undefined,
    } as unknown as ConfigService<AppEnvironment, true>,
  );

const createRequest = (cookie: string): Request =>
  ({ header: (name: string): string | undefined => name === 'cookie' ? cookie : undefined }) as unknown as Request;

describe('BrowserSsoStateCookieService', () => {
  it('只将 state 摘要写入短期 HttpOnly Cookie', () => {
    const cookie = vi.fn();
    const response = { cookie } as unknown as Response;

    createService().set(response, 'state-secret-value');

    const call = cookie.mock.calls[0];
    expect(call?.[0]).toBe('__Host-gaoq_sso_state');
    expect(call?.[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call?.[1]).not.toContain('state-secret-value');
    expect(call?.[2]).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 300_000,
    });
  });

  it('只有同一浏览器持有匹配摘要时通过', () => {
    const cookie = vi.fn();
    const response = { cookie } as unknown as Response;
    const service = createService();
    service.set(response, 'state-secret-value');
    const digest = cookie.mock.calls[0]?.[1] as string;

    expect(() =>
      service.assertBound(
        createRequest(`__Host-gaoq_sso_state=${digest}`),
        'state-secret-value',
      ),
    ).not.toThrow();
    expect(() =>
      service.assertBound(createRequest(`__Host-gaoq_sso_state=${digest}`), 'attacker-state'),
    ).toThrow(UnauthorizedException);
  });

  it('开发环境使用非 Host Cookie 并以完全相同属性清除', () => {
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const response = { cookie, clearCookie } as unknown as Response;
    const service = createService('development');
    service.set(response, 'state-secret-value');
    service.clear(response);

    expect(cookie.mock.calls[0]?.[0]).toBe('gaoq_sso_state');
    expect(cookie.mock.calls[0]?.[2]).toMatchObject({ secure: false });
    expect(clearCookie).toHaveBeenCalledWith('gaoq_sso_state', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  it.each([
    '',
    'other=value',
    '__Host-gaoq_sso_state=short',
    '__Host-gaoq_sso_state=$'.concat('A'.repeat(42)),
  ])('拒绝缺失或非规范摘要 Cookie：%s', (header) => {
    expect(() => createService().assertBound(
      createRequest(header), 'state-secret-value',
    )).toThrow(UnauthorizedException);
  });

  it('拒绝重复同名 Cookie、超长 Header 与前缀混淆', () => {
    const cookie = vi.fn();
    const service = createService();
    service.set({ cookie } as unknown as Response, 'state-secret-value');
    const digest = cookie.mock.calls[0]?.[1] as string;

    for (const header of [
      `__Host-gaoq_sso_state=${digest}; __Host-gaoq_sso_state=${digest}`,
      `padding=${'A'.repeat(8 * 1024)}; __Host-gaoq_sso_state=${digest}`,
      `x__Host-gaoq_sso_state=${digest}`,
    ]) {
      expect(() => service.assertBound(
        createRequest(header), 'state-secret-value',
      )).toThrow(UnauthorizedException);
    }
  });
});
