import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';

const createService = () =>
  new BrowserSsoStateCookieService(
    {
      get: (key: string): string | undefined =>
        key === 'NODE_ENV' ? 'production' : undefined,
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
});
