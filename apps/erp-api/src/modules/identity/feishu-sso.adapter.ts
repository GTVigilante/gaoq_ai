import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ExternalIdentityProfile } from './auth.types.js';
import {
  FeishuSsoAdapterToken,
  type SsoAuthorizationCodeInput,
} from './sso-adapter.js';
import { SsoHttpClient } from './sso-http-client.js';

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const FEISHU_PROFILE_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

const tokenSchema = z.object({
  code: z.number().optional(),
  access_token: z.string().min(1),
});
const profileSchema = z.object({
  code: z.number().optional(),
  tenant_key: z.string().min(1),
  union_id: z.string().min(1),
  user_id: z.string().min(1).optional(),
  open_id: z.string().min(1),
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
    return {
      provider: this.provider,
      externalTenantId: profile.tenant_key,
      unionId: profile.union_id,
      externalUserId: profile.user_id ?? profile.open_id,
      displayName: profile.name,
    };
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
