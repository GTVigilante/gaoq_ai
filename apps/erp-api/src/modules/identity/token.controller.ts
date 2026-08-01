import { Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { PublicRoute } from '../../core/http/public-route.decorator.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { TokenGrantService } from './token-grant.service.js';

@Controller('auth/token')
export class TokenController {
  constructor(
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
  ) {}

  /** 原子轮换 HttpOnly Refresh Token，并返回新的短期访问令牌。 */
  @PublicRoute()
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, string | number>> {
    this.cookies.assertTrustedOrigin(request);
    let grant: Awaited<ReturnType<TokenGrantService['refresh']>>;
    try {
      grant = await this.grants.refresh(this.cookies.readRequired(request));
    } catch (error) {
      if (error instanceof UnauthorizedException) this.cookies.clear(response);
      throw error;
    }
    this.cookies.set(response, grant.refreshToken);
    return {
      accessToken: grant.accessToken,
      tokenType: grant.tokenType,
      expiresIn: grant.expiresIn,
      scope: grant.scope,
    };
  }
}
