import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { DingTalkSsoAdapter } from './dingtalk-sso.adapter.js';
import { FeishuSsoAdapter } from './feishu-sso.adapter.js';
import { OpSsoAdapter } from './op-sso.adapter.js';
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
      adapter.buildAuthorizationUrl({
        state: 'state-001', codeChallenge: 'challenge-001', externalTenantId: 'feishu-tenant',
      }),
    );

    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', expectedExternalTenantId: 'feishu-tenant',
    })).resolves.toEqual({
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

    await expect(adapter.exchangeAuthorizationCode({
      code: 'bad-code', expectedExternalTenantId: 'feishu-tenant',
    })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('缺少跨应用 user_id 时拒绝绑定，不降级为 open_id', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ code: 0, access_token: 'provider-access-token' });
    http.getJson.mockResolvedValue({
      code: 0,
      tenant_key: 'feishu-tenant',
      union_id: 'union-001',
      open_id: 'open-001',
      name: '员工甲',
    });
    const adapter = new FeishuSsoAdapter(
      createConfig({
        FEISHU_CLIENT_ID: 'client-id',
        FEISHU_CLIENT_SECRET: 'client-secret',
        FEISHU_REDIRECT_URI: 'https://erp.example.com/sso/feishu/callback',
      }),
      http,
    );

    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', expectedExternalTenantId: 'feishu-tenant',
    }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('平台租户与 state 不一致时由适配器失败关闭', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ code: 0, access_token: 'provider-access-token' });
    http.getJson.mockResolvedValue({
      code: 0,
      tenant_key: 'attacker-tenant',
      union_id: 'union-001',
      user_id: 'user-001',
      open_id: 'open-001',
      name: '员工甲',
    });
    const adapter = new FeishuSsoAdapter(createConfig({
      FEISHU_CLIENT_ID: 'client-id',
      FEISHU_CLIENT_SECRET: 'client-secret',
      FEISHU_REDIRECT_URI: 'https://erp.example.com/sso/feishu/callback',
    }), http);

    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code',
      codeVerifier: 'verifier-001',
      expectedExternalTenantId: 'feishu-tenant',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });
    expect(http.postJson.mock.calls[0]?.[0].body?.code_verifier).toBe('verifier-001');
  });

  it('拒绝平台错误码与缺失配置', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({ code: 0, access_token: 'provider-access-token' });
    http.getJson.mockResolvedValue({
      code: 10003,
      tenant_key: 'feishu-tenant',
      union_id: 'union-001',
      user_id: 'user-001',
      open_id: 'open-001',
      name: '员工甲',
    });
    const configured = new FeishuSsoAdapter(createConfig({
      FEISHU_CLIENT_ID: 'client-id',
      FEISHU_CLIENT_SECRET: 'client-secret',
      FEISHU_REDIRECT_URI: 'https://erp.example.com/sso/feishu/callback',
    }), http);
    await expect(configured.exchangeAuthorizationCode({
      code: 'one-time-code', expectedExternalTenantId: 'feishu-tenant',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });

    const missing = new FeishuSsoAdapter(createConfig({}), http);
    expect(() => missing.buildAuthorizationUrl({
      state: 'state', codeChallenge: 'challenge', externalTenantId: 'tenant',
    })).toThrow('飞书 SSO 未配置');
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
      adapter.buildAuthorizationUrl({
        state: 'state-002', codeChallenge: 'challenge-002', externalTenantId: 'ding-tenant',
      }),
    );
    const profile = await adapter.exchangeAuthorizationCode({
      code: 'one-time-code', expectedExternalTenantId: 'ding-tenant',
    });

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
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it('令牌企业与 state 不一致时不读取用户资料', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({
      accessToken: 'provider-access-token', corpId: 'attacker-tenant',
    });
    const adapter = new DingTalkSsoAdapter(createConfig({
      DINGTALK_CLIENT_ID: 'client-id',
      DINGTALK_CLIENT_SECRET: 'client-secret',
      DINGTALK_REDIRECT_URI: 'https://erp.example.com/sso/dingtalk/callback',
    }), http);
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code',
      codeVerifier: 'verifier-001',
      expectedExternalTenantId: 'ding-tenant',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });
    expect(http.getJson).not.toHaveBeenCalled();
    expect(http.postJson.mock.calls[0]?.[0].body?.codeVerifier).toBe('verifier-001');
  });

  it('拒绝异常令牌、异常资料与缺失配置', async () => {
    const http = new StubHttpClient();
    const adapter = new DingTalkSsoAdapter(createConfig({
      DINGTALK_CLIENT_ID: 'client-id',
      DINGTALK_CLIENT_SECRET: 'client-secret',
      DINGTALK_REDIRECT_URI: 'https://erp.example.com/sso/dingtalk/callback',
    }), http);
    http.postJson.mockResolvedValueOnce({ message: 'invalid' });
    await expect(adapter.exchangeAuthorizationCode({
      code: 'bad', expectedExternalTenantId: 'ding-tenant',
    })).rejects.toMatchObject({ response: { code: 'SSO_CODE_REJECTED' } });

    http.postJson.mockResolvedValueOnce({
      accessToken: 'provider-access-token', corpId: 'ding-tenant',
    });
    http.getJson.mockResolvedValueOnce({ unionId: '$bad', openId: 'open-001', nick: '员工乙' });
    await expect(adapter.exchangeAuthorizationCode({
      code: 'code', expectedExternalTenantId: 'ding-tenant',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });

    const missing = new DingTalkSsoAdapter(createConfig({}), http);
    expect(() => missing.buildAuthorizationUrl({
      state: 'state', codeChallenge: 'challenge', externalTenantId: 'tenant',
    })).toThrow('钉钉 SSO 未配置');
  });
});

describe('OP SSO 适配器', () => {
  it('固定 OP 根域并以 PKCE 交换最小身份，访问令牌不离开适配器', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({
      code: 'OK',
      data: { accessToken: 'a'.repeat(32), tokenType: 'Bearer', expiresIn: 300 },
    });
    http.getJson.mockResolvedValue({
      code: 'OK',
      data: {
        externalTenantId: 'op-tenant-001', unionId: 'op-union-001',
        externalUserId: 'op-user-001', displayName: '员工丙',
      },
    });
    const adapter = new OpSsoAdapter(createConfig({
      OP_API_BASE_URL: 'https://op.example.net',
      OP_SSO_CLIENT_ID: 'op-sso-client-001',
      OP_SSO_CLIENT_SECRET: 's'.repeat(32),
      OP_SSO_REDIRECT_URI: 'https://erp.example.com/api/auth/sso/op/callback',
    }), http);

    const authorizationUrl = new URL(adapter.buildAuthorizationUrl({
      state: 'state-003', codeChallenge: 'challenge-003',
      externalTenantId: 'op-tenant-001',
    }));
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', codeVerifier: 'v'.repeat(43),
      expectedExternalTenantId: 'op-tenant-001',
    })).resolves.toEqual({
      provider: 'op', externalTenantId: 'op-tenant-001', unionId: 'op-union-001',
      externalUserId: 'op-user-001', displayName: '员工丙',
    });

    expect(authorizationUrl.toString().startsWith('https://op.example.net/oauth2/authorize?')).toBe(true);
    expect(authorizationUrl.searchParams.get('external_tenant_id')).toBe('op-tenant-001');
    const tokenRequest = http.postJson.mock.calls[0]?.[0];
    expect(tokenRequest?.url).toBe('https://op.example.net/erp/v1/sso/token');
    expect(tokenRequest?.body?.code_verifier).toBe('v'.repeat(43));
    expect(http.getJson).toHaveBeenCalledWith({
      url: 'https://op.example.net/erp/v1/sso/userinfo',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
  });

  it('OP 返回的租户与 state 绑定不一致时拒绝身份', async () => {
    const http = new StubHttpClient();
    http.postJson.mockResolvedValue({
      code: 'OK', data: { accessToken: 'a'.repeat(32), tokenType: 'Bearer', expiresIn: 300 },
    });
    http.getJson.mockResolvedValue({
      code: 'OK', data: {
        externalTenantId: 'attacker-tenant', unionId: 'op-union-001',
        externalUserId: 'op-user-001', displayName: '员工丙',
      },
    });
    const adapter = new OpSsoAdapter(createConfig({
      OP_API_BASE_URL: 'https://op.example.net', OP_SSO_CLIENT_ID: 'op-sso-client-001',
      OP_SSO_CLIENT_SECRET: 's'.repeat(32),
      OP_SSO_REDIRECT_URI: 'https://erp.example.com/api/auth/sso/op/callback',
    }), http);
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', codeVerifier: 'v'.repeat(43),
      expectedExternalTenantId: 'op-tenant-001',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });
  });

  it('缺少 PKCE、异常令牌或异常资料时失败关闭', async () => {
    const http = new StubHttpClient();
    const adapter = new OpSsoAdapter(createConfig({
      OP_API_BASE_URL: 'https://op.example.net',
      OP_SSO_CLIENT_ID: 'op-sso-client-001',
      OP_SSO_CLIENT_SECRET: 's'.repeat(32),
      OP_SSO_REDIRECT_URI: 'https://erp.example.com/api/auth/sso/op/callback',
    }), http);
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', expectedExternalTenantId: 'op-tenant-001',
    })).rejects.toMatchObject({ response: { code: 'SSO_CODE_REJECTED' } });
    expect(http.postJson).not.toHaveBeenCalled();

    http.postJson.mockResolvedValueOnce({ code: 'ERROR' });
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', codeVerifier: 'v'.repeat(43),
      expectedExternalTenantId: 'op-tenant-001',
    })).rejects.toMatchObject({ response: { code: 'SSO_CODE_REJECTED' } });

    http.postJson.mockResolvedValueOnce({
      code: 'OK',
      data: { accessToken: 'a'.repeat(32), tokenType: 'Bearer', expiresIn: 300 },
    });
    http.getJson.mockResolvedValueOnce({ code: 'ERROR' });
    await expect(adapter.exchangeAuthorizationCode({
      code: 'one-time-code', codeVerifier: 'v'.repeat(43),
      expectedExternalTenantId: 'op-tenant-001',
    })).rejects.toMatchObject({ response: { code: 'SSO_PROFILE_REJECTED' } });
  });

  it('拒绝缺失配置与不安全 OP 根地址', () => {
    const http = new StubHttpClient();
    const missing = new OpSsoAdapter(createConfig({}), http);
    expect(() => missing.buildAuthorizationUrl({
      state: 'state', codeChallenge: 'challenge', externalTenantId: 'tenant',
    })).toThrow('OP SSO 未配置');

    for (const base of [
      'http://op.example.net',
      'https://user@op.example.net',
      'https://op.example.net/base',
      'https://op.example.net?query=1',
      'https://op.example.net#fragment',
      'https://op.example.net:8443',
    ]) {
      const unsafe = new OpSsoAdapter(createConfig({
        OP_API_BASE_URL: base,
        OP_SSO_CLIENT_ID: 'client-id',
        OP_SSO_REDIRECT_URI: 'https://erp.example.com/callback',
      }), http);
      expect(() => unsafe.buildAuthorizationUrl({
        state: 'state', codeChallenge: 'challenge', externalTenantId: 'tenant',
      })).toThrow('OP SSO 未安全配置');
    }
  });
});
