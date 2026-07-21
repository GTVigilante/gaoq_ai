import { createHash, timingSafeEqual } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AppEnvironment } from '../../config/environment.js';

@Injectable()
export class BrowserSsoStateCookieService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  /** 只把 state 摘要绑定到发起登录的浏览器，原文仍由 OAuth state 参数携带。 */
  set(response: Response, state: string): void {
    response.cookie(this.cookieName(), this.digest(state), {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'lax',
      path: '/',
      maxAge: 300_000,
    });
  }

  /** 回调必须同时持有 URL state 与浏览器 Cookie，校验后无论结果如何都应由控制器清除。 */
  assertBound(request: Request, state: string): void {
    const expected = this.digest(state);
    const actual = this.readCookie(request);
    if (
      actual === undefined ||
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    ) {
      throw new UnauthorizedException({ code: 'SSO_STATE_INVALID', message: 'SSO 登录状态无效或已过期' });
    }
  }

  clear(response: Response): void {
    response.clearCookie(this.cookieName(), {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'lax',
      path: '/',
    });
  }

  private readCookie(request: Request): string | undefined {
    const name = this.cookieName();
    return (request.header('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  }

  private digest(state: string): string {
    return createHash('sha256').update(state).digest('base64url');
  }

  private cookieName(): string {
    return this.isProduction() ? '__Host-gaoq_sso_state' : 'gaoq_sso_state';
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
