import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchOrgPlatformHttpClient } from './org-platform-http.client.js';

describe('FetchOrgPlatformHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('仅访问白名单域名并以固定超时、禁止重定向发送 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 0 }),
      { status: 200, headers: { 'x-request-id': 'request-001' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FetchOrgPlatformHttpClient();

    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
      query: { department_id_type: 'department_id' },
      body: { name: '财务部' },
    })).resolves.toMatchObject({ requestId: 'request-001', body: { code: 0 } });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://open.feishu.cn');
    expect(url.searchParams.get('department_id_type')).toBe('department_id');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('拒绝协议相对路径和路径穿越', async () => {
    const client = new FetchOrgPlatformHttpClient();
    await expect(client.request({
      origin: 'https://api.dingtalk.com',
      path: '//attacker.example/steal',
      method: 'GET',
    })).rejects.toThrow('请求路径非法');
    await expect(client.request({
      origin: 'https://api.dingtalk.com',
      path: '/v1.0/../steal',
      method: 'GET',
    })).rejects.toThrow('请求路径非法');
  });

  it('上游错误只返回稳定分类，不泄露敏感查询参数或响应正文', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 190004, msg: 'secret provider detail' }),
      { status: 429 },
    )));
    const client = new FetchOrgPlatformHttpClient();
    const error = await client.request({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/v2/department/create',
      method: 'POST',
      sensitiveQuery: { access_token: 'secret-access-token' },
      body: { name: '财务部' },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'ORG_PLATFORM_HTTP_429', category: 'retryable', providerCode: 190004,
    });
    expect(String(error)).not.toContain('secret-access-token');
    expect(String(error)).not.toContain('secret provider detail');
  });
});
