import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';
import { FetchSsoHttpClient } from './sso-http-client.js';

function client(opBase?: string): FetchSsoHttpClient {
  return new FetchSsoHttpClient({
    get: () => opBase,
  } as unknown as ConfigService<AppEnvironment, true>);
}

describe('FetchSsoHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('读取合法 JSON 且不跟随身份提供者重定向', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":"OK"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client().getJson({
      url: 'https://api.dingtalk.com/v1.0/contact/users/me',
    })).resolves.toEqual({ code: 'OK' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.dingtalk.com/v1.0/contact/users/me',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('缺少 Content-Length 时仍在流式读取阶段拒绝超限响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))));
    await expect(client().getJson({
      url: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    })).rejects.toMatchObject({ response: { code: 'SSO_UPSTREAM_ERROR' } });
  });

  it('在发起网络请求前拒绝任意域名、query 和非标准端口', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const url of [
      'https://attacker.example/userinfo',
      'https://api.dingtalk.com:8443/v1.0/contact/users/me',
      'https://api.dingtalk.com/v1.0/contact/users/me?next=internal',
    ]) {
      await expect(client().getJson({ url }))
        .rejects.toMatchObject({ response: { code: 'SSO_UPSTREAM_ERROR' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OP 仅允许配置根域下固定 token 与 userinfo 端点', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":"OK"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client('https://op.example.test/').postJson({
      url: 'https://op.example.test/erp/v1/sso/token', body: { code: 'opaque-code' },
    })).resolves.toEqual({ code: 'OK' });
    await expect(client('https://op.example.test/').getJson({
      url: 'https://op.example.test/admin',
    })).rejects.toMatchObject({ response: { code: 'SSO_UPSTREAM_ERROR' } });
  });
});
