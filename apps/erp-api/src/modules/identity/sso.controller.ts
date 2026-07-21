import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { PublicRoute } from '../../core/http/public-route.decorator.js';
import type { SsoProviderCode } from './auth.types.js';
import { SsoAdapterRegistry } from './sso-adapter.js';
import { SsoStateService } from './sso-state.service.js';
import { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';

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

@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly bindings: SsoTenantBindingRepository,
    private readonly states: SsoStateService,
    private readonly adapters: SsoAdapterRegistry,
  ) {}

  /** 为已登记的租户生成一次性 state 和带 PKCE 的供应商授权地址。 */
  @PublicRoute()
  @Post(':provider/start')
  async start(
    @Param('provider') providerValue: string,
    @Body() body: StartSsoRequest,
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
    return {
      authorizationUrl: this.adapters.get(provider).buildAuthorizationUrl(issued),
      expiresIn: 300,
    };
  }

  private parseProvider(value: string): SsoProviderCode {
    if (value !== 'dingtalk' && value !== 'feishu') {
      throw new BadRequestException({ code: 'SSO_PROVIDER_INVALID', message: 'SSO 提供者无效' });
    }
    return value;
  }
}
