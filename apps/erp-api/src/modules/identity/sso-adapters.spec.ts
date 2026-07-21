import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { DingTalkSsoAdapter } from './dingtalk-sso.adapter.js';
import { FeishuSsoAdapter } from './feishu-sso.adapter.js';
import { SsoHttpClient, type SsoHttpRequest } from './sso-http-client.js';

class StubHttpClient extends SsoHttpClient {
  readonly getJson = vi.fn<(request: SsoHttpRequest) => Promise<unknown>>();
  readonly postJson = vi.fn<(request: SsoHttpRequest) => Promise<unknown>>();
}

const createConfig = (
  values: Readonly<Record<string, string>>,
): ConfigService<AppEnvironment, true> =>
  ({
    get(key: string): string | undefined {
      return values[key];
    },
  }) as unknown as ConfigService<AppEnvironment, true>;

describe('飞书 SSO 适配器', () => {
  it('交换授权码并只返回最小外部身份', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ code: 0, access_token: 'provider-access-token' });
    http.getJson.mockResolvedValue({
      code: 0,
      tenant_key: 'feishu-tenant',
      union_id: 'union-001',
      user_id: 'user-001',
      open_id: 'open-001',
      name: '员工甲',
      email: 'should-not-leave-adapter@example.com',
    });
    const adapter = new FeishuSsoAdapter(
      createConfig({
        FEISHU_CLIENT_ID: 'client-id',
        FEISHU_CLIENT_SECRET: 'client-secret',
        FEISHU_REDIRECT_URI: 'https://erp.example.com/sso/feishu/callback',
      }),
      http,
    );

    const authorizationUrl = new URL(
      adapter.buildAuthorizationUrl({ state: 'state-001', codeChallenge: 'challenge-001' }),
    );

    await expect(adapter.exchangeAuthorizationCode({ code: 'one-time-code' })).resolves.toEqual({
      provider: 'feishu',
      externalTenantId: 'feishu-tenant',
      unionId: 'union-001',
      externalUserId: 'user-001',
      displayName: '员工甲',
    });
    expect(http.getJson).toHaveBeenCalledWith({
      url: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
      headers: { authorization: 'Bearer provider-access-token' },
    });
    expect(authorizationUrl.origin).toBe('https://accounts.feishu.cn');
    expect(authorizationUrl.searchParams.get('state')).toBe('state-001');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('拒绝结构异常的授权码响应', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ code: 10003, message: 'invalid code' });
    const adapter = new FeishuSsoAdapter(
      createConfig({
        FEISHU_CLIENT_ID: 'client-id',
        FEISHU_CLIENT_SECRET: 'client-secret',
        FEISHU_REDIRECT_URI: 'https://erp.example.com/sso/feishu/callback',
      }),
      http,
    );

    await expect(adapter.exchangeAuthorizationCode({ code: 'bad-code' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('钉钉 SSO 适配器', () => {
  it('使用专用令牌头读取身份且忽略手机号', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ accessToken: 'provider-access-token', corpId: 'ding-tenant' });
    http.getJson.mockResolvedValue({
      unionId: 'union-002',
      openId: 'open-002',
      nick: '员工乙',
      mobile: '13800000000',
    });
    const adapter = new DingTalkSsoAdapter(
      createConfig({
        DINGTALK_CLIENT_ID: 'client-id',
        DINGTALK_CLIENT_SECRET: 'client-secret',
        DINGTALK_REDIRECT_URI: 'https://erp.example.com/sso/dingtalk/callback',
      }),
      http,
    );

    const authorizationUrl = new URL(
      adapter.buildAuthorizationUrl({ state: 'state-002', codeChallenge: 'challenge-002' }),
    );
    const profile = await adapter.exchangeAuthorizationCode({ code: 'one-time-code' });

    expect(profile).toEqual({
      provider: 'dingtalk',
      externalTenantId: 'ding-tenant',
      unionId: 'union-002',
      externalUserId: 'open-002',
      displayName: '员工乙',
    });
    expect(http.getJson).toHaveBeenCalledWith({
      url: 'https://api.dingtalk.com/v1.0/contact/users/me',
      headers: { 'x-acs-dingtalk-access-token': 'provider-access-token' },
    });
    expect(authorizationUrl.origin).toBe('https://login.dingtalk.com');
    expect(authorizationUrl.searchParams.get('state')).toBe('state-002');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe('challenge-002');
  });
});
