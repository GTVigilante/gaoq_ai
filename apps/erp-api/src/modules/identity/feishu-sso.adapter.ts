import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ExternalIdentityProfile } from './auth.types.js';
import {
  FeishuSsoAdapterToken,
  type SsoAuthorizationCodeInput,
  type SsoAuthorizationUrlInput,
} from './sso-adapter.js';
import { SsoHttpClient } from './sso-http-client.js';

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const FEISHU_PROFILE_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const identifier = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);

const tokenSchema = z.object({
  code: z.number().optional(),
  access_token: z.string().min(1),
});
const profileSchema = z.object({
  code: z.number().optional(),
  tenant_key: identifier,
  union_id: identifier,
  user_id: identifier,
  open_id: identifier,
  name: z.string().min(1).max(256),
});

@Injectable()
export class FeishuSsoAdapter extends FeishuSsoAdapterToken {
  readonly provider = 'feishu' as const;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly http: SsoHttpClient,
  ) {
    super();
  }

  /** 构造固定飞书域名的授权地址，并绑定 state 与 PKCE S256。 */
  override buildAuthorizationUrl(input: SsoAuthorizationUrlInput): string {
    const url = new URL(FEISHU_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.requiredConfig('FEISHU_CLIENT_ID'),
      redirect_uri: this.requiredConfig('FEISHU_REDIRECT_URI'),
      response_type: 'code',
      scope: 'auth:user.id:read',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** 用一次性授权码取得最小身份；不返回、不记录飞书访问令牌。 */
  override async exchangeAuthorizationCode(
    input: SsoAuthorizationCodeInput,
  ): Promise<ExternalIdentityProfile> {
    const tokenResult = tokenSchema.safeParse(
      await this.http.postJson({
        url: FEISHU_TOKEN_URL,
        body: {
          grant_type: 'authorization_code',
          client_id: this.requiredConfig('FEISHU_CLIENT_ID'),
          client_secret: this.requiredConfig('FEISHU_CLIENT_SECRET'),
          code: input.code,
          redirect_uri: this.requiredConfig('FEISHU_REDIRECT_URI'),
          ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
        },
      }),
    );
    if (!tokenResult.success || tokenResult.data.code !== undefined && tokenResult.data.code !== 0) {
      throw new UnauthorizedException({ code: 'SSO_CODE_REJECTED', message: '飞书授权码无效' });
    }

    const profileResult = profileSchema.safeParse(
      await this.http.getJson({
        url: FEISHU_PROFILE_URL,
        headers: { authorization: `Bearer ${tokenResult.data.access_token}` },
      }),
    );
    if (!profileResult.success || profileResult.data.code !== undefined && profileResult.data.code !== 0) {
      throw new UnauthorizedException({ code: 'SSO_PROFILE_REJECTED', message: '无法验证飞书身份' });
    }
    const profile = profileResult.data;
    if (profile.tenant_key !== input.expectedExternalTenantId) {
      throw new UnauthorizedException({ code: 'SSO_PROFILE_REJECTED', message: '无法验证飞书身份' });
    }
    return Object.freeze({
      provider: this.provider,
      externalTenantId: profile.tenant_key,
      unionId: profile.union_id,
      externalUserId: profile.user_id,
      displayName: profile.name,
    });
  }

  private requiredConfig(
    key: 'FEISHU_CLIENT_ID' | 'FEISHU_CLIENT_SECRET' | 'FEISHU_REDIRECT_URI',
  ): string {
    const value = this.config.get(key, { infer: true });
    if (value === undefined || value.length === 0) {
      throw new ServiceUnavailableException({ code: 'SSO_NOT_CONFIGURED', message: '飞书 SSO 未配置' });
    }
    return value;
  }
}
