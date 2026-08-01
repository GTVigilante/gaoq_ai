import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ExternalIdentityProfile } from './auth.types.js';
import {
  OpSsoAdapterToken,
  type SsoAuthorizationCodeInput,
  type SsoAuthorizationUrlInput,
} from './sso-adapter.js';
import { SsoHttpClient } from './sso-http-client.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const tokenSchema = z.object({
  code: z.literal('OK'),
  data: z.object({
    accessToken: z.string().min(32).max(4_096),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().min(60).max(3_600),
  }).strict(),
}).strict();
const profileSchema = z.object({
  code: z.literal('OK'),
  data: z.object({
    externalTenantId: identifier,
    unionId: identifier,
    externalUserId: identifier,
    displayName: z.string().min(1).max(256),
  }).strict(),
}).strict();

/** OP OIDC 风格 SSO 适配器；OP 只认证身份，ERP 映射与授权仍由本地裁决。 */
@Injectable()
export class OpSsoAdapter extends OpSsoAdapterToken {
  readonly provider = 'op' as const;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly http: SsoHttpClient,
  ) {
    super();
  }

  override buildAuthorizationUrl(input: SsoAuthorizationUrlInput): string {
    const url = this.endpoint('/oauth2/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.requiredConfig('OP_SSO_CLIENT_ID'),
      redirect_uri: this.requiredConfig('OP_SSO_REDIRECT_URI'),
      scope: 'openid profile',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      external_tenant_id: input.externalTenantId,
    }).toString();
    return url.toString();
  }

  override async exchangeAuthorizationCode(
    input: SsoAuthorizationCodeInput,
  ): Promise<ExternalIdentityProfile> {
    if (input.codeVerifier === undefined || input.codeVerifier.length < 32) {
      throw this.rejected('SSO_CODE_REJECTED');
    }
    const token = tokenSchema.safeParse(await this.http.postJson({
      url: this.endpoint('/erp/v1/sso/token').toString(),
      body: {
        grant_type: 'authorization_code',
        client_id: this.requiredConfig('OP_SSO_CLIENT_ID'),
        client_secret: this.requiredConfig('OP_SSO_CLIENT_SECRET'),
        redirect_uri: this.requiredConfig('OP_SSO_REDIRECT_URI'),
        code: input.code,
        code_verifier: input.codeVerifier,
        external_tenant_id: input.expectedExternalTenantId,
      },
    }));
    if (!token.success) throw this.rejected('SSO_CODE_REJECTED');
    const profile = profileSchema.safeParse(await this.http.getJson({
      url: this.endpoint('/erp/v1/sso/userinfo').toString(),
      headers: { authorization: `Bearer ${token.data.data.accessToken}` },
    }));
    if (!profile.success ||
      profile.data.data.externalTenantId !== input.expectedExternalTenantId) {
      throw this.rejected('SSO_PROFILE_REJECTED');
    }
    return Object.freeze({ provider: this.provider, ...profile.data.data });
  }

  private endpoint(path: '/oauth2/authorize' | '/erp/v1/sso/token' | '/erp/v1/sso/userinfo'): URL {
    const base = this.requiredConfig('OP_API_BASE_URL');
    const configured = new URL(base);
    if (
      configured.protocol !== 'https:' || configured.pathname !== '/' ||
      configured.username !== '' || configured.password !== '' ||
      configured.search !== '' || configured.hash !== '' ||
      (configured.port !== '' && configured.port !== '443')
    ) throw new ServiceUnavailableException({
      code: 'SSO_NOT_CONFIGURED', message: 'OP SSO 未安全配置',
    });
    const endpoint = new URL(path, configured);
    if (endpoint.origin !== configured.origin) throw new Error('OP_SSO_ENDPOINT_INVALID');
    return endpoint;
  }

  private requiredConfig(
    key: 'OP_API_BASE_URL' | 'OP_SSO_CLIENT_ID' | 'OP_SSO_CLIENT_SECRET' | 'OP_SSO_REDIRECT_URI',
  ): string {
    const value = this.config.get(key, { infer: true });
    if (value === undefined || value.length === 0) throw new ServiceUnavailableException({
      code: 'SSO_NOT_CONFIGURED', message: 'OP SSO 未配置',
    });
    return value;
  }

  private rejected(code: 'SSO_CODE_REJECTED' | 'SSO_PROFILE_REJECTED'): UnauthorizedException {
    return new UnauthorizedException({ code, message: '无法验证 OP 身份' });
  }
}
