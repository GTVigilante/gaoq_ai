import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ExternalIdentityProfile } from './auth.types.js';
import {
  DingTalkSsoAdapterToken,
  type SsoAuthorizationCodeInput,
  type SsoAuthorizationUrlInput,
} from './sso-adapter.js';
import { SsoHttpClient } from './sso-http-client.js';

const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_PROFILE_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';
const DINGTALK_AUTHORIZE_URL = 'https://login.dingtalk.com/oauth2/auth';
const identifier = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  corpId: identifier,
});
const profileSchema = z.object({
  unionId: identifier,
  openId: identifier,
  nick: z.string().min(1).max(256),
});

@Injectable()
export class DingTalkSsoAdapter extends DingTalkSsoAdapterToken {
  readonly provider = 'dingtalk' as const;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly http: SsoHttpClient,
  ) {
    super();
  }

  /** 构造固定钉钉域名的授权地址，并绑定 state 与 PKCE S256。 */
  override buildAuthorizationUrl(input: SsoAuthorizationUrlInput): string {
    const url = new URL(DINGTALK_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      redirect_uri: this.requiredConfig('DINGTALK_REDIRECT_URI'),
      response_type: 'code',
      client_id: this.requiredConfig('DINGTALK_CLIENT_ID'),
      scope: 'openid',
      state: input.state,
      prompt: 'consent',
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** 用一次性授权码取得最小身份；手机号、邮箱不进入映射判定。 */
  override async exchangeAuthorizationCode(
    input: SsoAuthorizationCodeInput,
  ): Promise<ExternalIdentityProfile> {
    const tokenResult = tokenSchema.safeParse(
      await this.http.postJson({
        url: DINGTALK_TOKEN_URL,
        body: {
          grantType: 'authorization_code',
          clientId: this.requiredConfig('DINGTALK_CLIENT_ID'),
          clientSecret: this.requiredConfig('DINGTALK_CLIENT_SECRET'),
          code: input.code,
          ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
        },
      }),
    );
    if (!tokenResult.success) {
      throw new UnauthorizedException({ code: 'SSO_CODE_REJECTED', message: '钉钉授权码无效' });
    }
    if (tokenResult.data.corpId !== input.expectedExternalTenantId) {
      throw new UnauthorizedException({
        code: 'SSO_PROFILE_REJECTED',
        message: '无法验证钉钉身份',
      });
    }

    const profileResult = profileSchema.safeParse(
      await this.http.getJson({
        url: DINGTALK_PROFILE_URL,
        headers: { 'x-acs-dingtalk-access-token': tokenResult.data.accessToken },
      }),
    );
    if (!profileResult.success) {
      throw new UnauthorizedException({ code: 'SSO_PROFILE_REJECTED', message: '无法验证钉钉身份' });
    }
    return Object.freeze({
      provider: this.provider,
      externalTenantId: tokenResult.data.corpId,
      unionId: profileResult.data.unionId,
      externalUserId: profileResult.data.openId,
      displayName: profileResult.data.nick,
    });
  }

  private requiredConfig(
    key: 'DINGTALK_CLIENT_ID' | 'DINGTALK_CLIENT_SECRET' | 'DINGTALK_REDIRECT_URI',
  ): string {
    const value = this.config.get(key, { infer: true });
    if (value === undefined || value.length === 0) {
      throw new ServiceUnavailableException({ code: 'SSO_NOT_CONFIGURED', message: '钉钉 SSO 未配置' });
    }
    return value;
  }
}
