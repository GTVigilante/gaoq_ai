import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchSsoHttpClient } from './sso-http-client.js';

describe('FetchSsoHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('读取合法 JSON 且不跟随身份提供者重定向', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":"OK"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new FetchSsoHttpClient().getJson({
      url: 'https://idp.example.net/userinfo',
    })).resolves.toEqual({ code: 'OK' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://idp.example.net/userinfo',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('缺少 Content-Length 时仍在流式读取阶段拒绝超限响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))));
    await expect(new FetchSsoHttpClient().getJson({
      url: 'https://idp.example.net/userinfo',
    })).rejects.toMatchObject({ response: { code: 'SSO_UPSTREAM_ERROR' } });
  });
});
