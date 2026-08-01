import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AppEnvironment } from '../../config/environment.js';

const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{64}$/;
const MAX_COOKIE_HEADER_LENGTH = 8_192;

@Injectable()
export class BrowserRefreshCookieService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  /** Refresh Token 只存 HttpOnly Cookie，不进入 URL、响应 JSON 或前端存储。 */
  set(response: Response, refreshToken: string): void {
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      throw new Error('刷新令牌格式非法');
    }
    response.cookie(this.cookieName(), refreshToken, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'strict',
      path: '/',
      maxAge: this.config.get('AUTH_REFRESH_TOKEN_TTL_SECONDS', { infer: true }) * 1000,
    });
  }

  clear(response: Response): void {
    response.clearCookie(this.cookieName(), {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'strict',
      path: '/',
    });
  }

  /** 浏览器刷新入口强制校验精确 Origin，阻止 Cookie 驱动的跨站请求。 */
  assertTrustedOrigin(request: Request): void {
    if (request.header('origin') !== this.config.get('WEB_ORIGIN', { infer: true })) {
      throw new ForbiddenException({ code: 'AUTH_ORIGIN_REJECTED', message: '请求来源不受信任' });
    }
  }

  readRequired(request: Request): string {
    const name = this.cookieName();
    const cookieHeader = request.header('cookie') ?? '';
    if (cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) {
      throw this.invalidGrant();
    }
    const matches = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    if (matches.length !== 1) throw this.invalidGrant();
    const token = matches[0]?.slice(name.length + 1);
    if (token === undefined || !REFRESH_TOKEN_PATTERN.test(token)) throw this.invalidGrant();
    return token;
  }

  private invalidGrant(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_INVALID_GRANT',
      message: '登录凭据无效或已失效',
    });
  }

  private cookieName(): string {
    return this.isProduction() ? '__Host-gaoq_refresh' : 'gaoq_refresh';
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
