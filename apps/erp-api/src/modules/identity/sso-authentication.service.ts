import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { SsoProviderCode } from './auth.types.js';
import { ExternalIdentityRepository } from './external-identity.repository.js';
import { SsoAdapterRegistry } from './sso-adapter.js';
import { SsoStateService } from './sso-state.service.js';

export interface VerifiedSsoIdentity {
  readonly tenantId: string;
  readonly actorId: string;
  readonly employeeId: string;
  readonly provider: SsoProviderCode;
  readonly returnPath: string;
}

@Injectable()
export class SsoAuthenticationService {
  constructor(
    private readonly states: SsoStateService,
    private readonly adapters: SsoAdapterRegistry,
    private readonly identities: ExternalIdentityRepository,
  ) {}

  /**
   * 消费一次性 state、验证平台租户与双标识映射，返回仅供授权设施使用的可信主体。
   */
  async verifyAuthorizationCode(input: {
    readonly provider: SsoProviderCode;
    readonly state: string;
    readonly code: string;
  }): Promise<VerifiedSsoIdentity> {
    const state = await this.states.consume(input.state, input.provider);
    const profile = await this.adapters.get(input.provider).exchangeAuthorizationCode({
      code: input.code,
      codeVerifier: state.codeVerifier,
    });
    if (profile.externalTenantId !== state.externalTenantId) {
      throw this.invalidIdentity();
    }
    const mapping = await this.identities.findBoundByExternalProfile(state.tenantId, profile);
    if (mapping === null) {
      throw new UnauthorizedException({
        code: 'SSO_BINDING_REQUIRED',
        message: '外部身份尚未绑定 ERP 员工',
      });
    }
    return {
      tenantId: mapping.tenantId,
      actorId: mapping.actorId,
      employeeId: mapping.employeeId,
      provider: profile.provider,
      returnPath: state.returnPath,
    };
  }

  private invalidIdentity(): UnauthorizedException {
    return new UnauthorizedException({ code: 'SSO_IDENTITY_INVALID', message: '外部身份验证失败' });
  }
}
