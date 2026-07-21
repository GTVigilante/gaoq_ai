import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';

import { PublicRoute } from '../../core/http/public-route.decorator.js';
import type { SsoProviderCode } from './auth.types.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';
import { SsoAdapterRegistry } from './sso-adapter.js';
import { SsoStateService } from './sso-state.service.js';
import { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';
import { TokenGrantService } from './token-grant.service.js';

export class StartSsoRequest {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  tenantSlug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^\/(?!\/)[^\\:]*$/)
  returnPath!: string;
}

export class CompleteSsoRequest {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  state!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  code!: string;
}

@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly bindings: SsoTenantBindingRepository,
    private readonly states: SsoStateService,
    private readonly adapters: SsoAdapterRegistry,
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly stateCookie: BrowserSsoStateCookieService,
  ) {}

  /** 为已登记的租户生成一次性 state 和带 PKCE 的供应商授权地址。 */
  @PublicRoute()
  @Post(':provider/start')
  async start(
    @Param('provider') providerValue: string,
    @Body() body: StartSsoRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly authorizationUrl: string; readonly expiresIn: number }> {
    const provider = this.parseProvider(providerValue);
    const binding = await this.bindings.resolveActive(body.tenantSlug, provider);
    if (binding === null) {
      throw new UnauthorizedException({ code: 'SSO_LOGIN_UNAVAILABLE', message: 'SSO 登录不可用' });
    }
    const issued = await this.states.issue({
      tenantId: binding.tenantId,
      provider,
      externalTenantId: binding.externalTenantId,
      returnPath: body.returnPath,
    });
    this.stateCookie.set(response, issued.state);
    return {
      authorizationUrl: this.adapters.get(provider).buildAuthorizationUrl({
        ...issued,
        externalTenantId: binding.externalTenantId,
      }),
      expiresIn: 300,
    };
  }

  /** 完成供应商回调；Refresh Token 仅写入 HttpOnly Cookie。 */
  @PublicRoute()
  @Post(':provider/callback')
  async callback(
    @Param('provider') providerValue: string,
    @Body() body: CompleteSsoRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, string | number>> {
    this.cookies.assertTrustedOrigin(request);
    try {
      this.stateCookie.assertBound(request, body.state);
      const grant = await this.grants.issueFromSso({
        provider: this.parseProvider(providerValue),
        state: body.state,
        code: body.code,
      });
      this.cookies.set(response, grant.refreshToken);
      return {
        accessToken: grant.accessToken,
        tokenType: grant.tokenType,
        expiresIn: grant.expiresIn,
        scope: grant.scope,
        returnPath: grant.returnPath,
      };
    } finally {
      this.stateCookie.clear(response);
    }
  }

  private parseProvider(value: string): SsoProviderCode {
    if (value !== 'dingtalk' && value !== 'feishu' && value !== 'op') {
      throw new BadRequestException({ code: 'SSO_PROVIDER_INVALID', message: 'SSO 提供者无效' });
    }
    return value;
  }
}
