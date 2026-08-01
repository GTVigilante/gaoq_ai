import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  FetchOpOrgHttpClient,
  type OpOrgHttpRequest,
} from './op-org-http.client.js';
import {
  FetchOrgPlatformHttpClient,
  type OrgPlatformHttpRequest,
} from './org-platform-http.client.js';

const MAX_RESPONSE_BYTES = 256 * 1024;

describe('FetchOrgPlatformHttpClient 失败关闭边界', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('拒绝非白名单目标、非法路径和危险请求头', async () => {
    const client = new FetchOrgPlatformHttpClient();
    await expect(client.request({
      origin: 'https://attacker.example',
      path: '/api',
      method: 'GET',
    } as unknown as OrgPlatformHttpRequest)).rejects.toThrow('目标域名不在白名单');
    await expect(client.request({
      origin: 'https://api.dingtalk.com',
      path: 'relative',
      method: 'GET',
    })).rejects.toThrow('请求路径非法');
    for (const header of ['Host', 'content-length']) {
      await expect(client.request({
        origin: 'https://api.dingtalk.com',
        path: '/v1.0/contact/departments',
        method: 'GET',
        headers: { [header]: 'invalid' },
      })).rejects.toThrow('请求头非法');
    }
  });

  it('网络、读取、响应大小和 JSON 格式异常使用稳定错误码', async () => {
    const client = new FetchOrgPlatformHttpClient();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret network detail')));
    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({ code: 'ORG_PLATFORM_NETWORK_ERROR' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      headers: new Headers(),
      text: vi.fn().mockRejectedValue(new Error('read failed')),
      ok: true,
      status: 200,
    }));
    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({ code: 'ORG_PLATFORM_RESPONSE_READ_ERROR' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    })));
    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({ code: 'ORG_PLATFORM_RESPONSE_TOO_LARGE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'x'.repeat(MAX_RESPONSE_BYTES + 1),
    )));
    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({ code: 'ORG_PLATFORM_RESPONSE_TOO_LARGE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{invalid-json')));
    await expect(client.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({ code: 'ORG_PLATFORM_RESPONSE_INVALID' });
  });

  it('空响应和备用请求标识均安全解析，未定义查询值不进入 URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'x-acs-request-id': 'acs-request' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'x-tt-logid': 'tt-request' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new FetchOrgPlatformHttpClient();

    await expect(client.request({
      origin: 'https://api.dingtalk.com',
      path: '/v1.0/contact/departments',
      method: 'GET',
      query: { cursor: undefined },
    })).resolves.toEqual({ status: 200, requestId: 'acs-request', body: {} });
    await expect(client.request({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/v2/department/listsub',
      method: 'POST',
    })).resolves.toEqual({ status: 200, requestId: 'tt-request', body: {} });

    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(firstUrl.search).toBe('');
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(secondInit.headers).toEqual({ accept: 'application/json' });
    expect(secondInit).not.toHaveProperty('body');
  });

  it.each([
    [408, 'retryable'],
    [425, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [409, 'conflict'],
    [412, 'conflict'],
    [400, 'business'],
  ] as const)('HTTP %s 映射为 %s 且不泄露响应正文', async (status, category) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ errcode: 12345, secret: 'must-not-leak' }),
      { status },
    )));
    const error = await new FetchOrgPlatformHttpClient().request({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/v2/department/update',
      method: 'POST',
      sensitiveQuery: { access_token: 'must-not-leak-token' },
      body: { name: '财务部' },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: `ORG_PLATFORM_HTTP_${status}`,
      category,
      providerCode: 12345,
    });
    expect(String(error)).not.toContain('must-not-leak');
  });

  it('非对象错误响应不猜测 providerCode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(['unexpected']),
      { status: 400, headers: { 'content-length': 'not-a-number' } },
    )));
    await expect(new FetchOrgPlatformHttpClient().request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/contact/v3/departments',
      method: 'GET',
    })).rejects.toMatchObject({
      code: 'ORG_PLATFORM_HTTP_400',
      category: 'business',
      providerCode: undefined,
    });
  });
});

describe('FetchOpOrgHttpClient 失败关闭边界', () => {
  afterEach(() => vi.unstubAllGlobals());

  function client(baseUrl: string | null = 'https://op.example.net') {
    return new FetchOpOrgHttpClient(new ConfigService<AppEnvironment, true>({
      ...(baseUrl === null ? {} : { OP_API_BASE_URL: baseUrl }),
    } as AppEnvironment));
  }

  const snapshotRequest: OpOrgHttpRequest = {
    method: 'GET',
    path: '/erp/v1/org/snapshot',
    headers: {},
  };

  it('缺少 OP 地址时失败关闭', async () => {
    await expect(client(null).request(snapshotRequest)).rejects.toMatchObject({
      code: 'OP_API_UNAVAILABLE',
      category: 'retryable',
    });
  });

  it.each([
    ['http://op.example.net'],
    ['https://user@op.example.net'],
    ['https://op.example.net/base'],
    ['https://op.example.net?query=1'],
    ['https://op.example.net#fragment'],
    ['https://op.example.net:8443'],
  ])('拒绝非标准 HTTPS 根地址 %s', async (baseUrl) => {
    await expect(client(baseUrl).request(snapshotRequest)).rejects.toThrow(
      'OP_ORG_BASE_URL_INVALID',
    );
  });

  it.each(['Host', 'content-length', 'transfer-encoding'])(
    '拒绝危险请求头 %s',
    async (header) => {
      await expect(client().request({
        ...snapshotRequest,
        headers: { [header]: 'invalid' },
      })).rejects.toThrow('OP_ORG_HEADER_INVALID');
    },
  );

  it('网络异常不泄露请求正文或签名', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network detail')));
    const error = await client().request({
      method: 'PUT',
      path: '/erp/v1/org/employees/employee-a',
      headers: { 'x-gaoq-erp-signature': 'secret-signature' },
      body: '{"secret":"value"}',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'OP_ORG_NETWORK_ERROR', category: 'retryable' });
    expect(String(error)).not.toContain('secret-signature');
    expect(String(error)).not.toContain('private network detail');
  });

  it('Content-Length、流式读取和 JSON 格式均有硬边界', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    })));
    await expect(client().request(snapshotRequest)).rejects.toMatchObject({
      code: 'OP_ORG_RESPONSE_TOO_LARGE',
    });

    const readFailureReader = {
      read: vi.fn().mockRejectedValue(new Error('read failed')),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: { getReader: () => readFailureReader },
    }));
    await expect(client().request(snapshotRequest)).rejects.toMatchObject({
      code: 'OP_ORG_RESPONSE_READ_ERROR',
    });
    expect(readFailureReader.releaseLock).toHaveBeenCalledOnce();

    const invalidChunkReader = {
      read: vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: { getReader: () => invalidChunkReader },
    }));
    await expect(client().request(snapshotRequest)).rejects.toMatchObject({
      code: 'OP_ORG_RESPONSE_READ_ERROR',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{invalid-json')));
    await expect(client().request(snapshotRequest)).rejects.toMatchObject({
      code: 'OP_ORG_RESPONSE_INVALID',
    });
  });

  it('空正文和缺少 requestId 时返回最小响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'content-length': 'not-a-number' },
    })));
    await expect(client().request(snapshotRequest)).resolves.toEqual({
      status: 200,
      requestId: undefined,
      body: {},
    });
  });

  it.each([
    [408, 'retryable'],
    [425, 'retryable'],
    [429, 'retryable'],
    [503, 'retryable'],
    [409, 'conflict'],
    [412, 'conflict'],
    [403, 'business'],
  ] as const)('OP HTTP %s 映射为 %s', async (status, category) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'ERROR' }),
      { status },
    )));
    await expect(client().request(snapshotRequest)).rejects.toMatchObject({
      code: `OP_ORG_HTTP_${status}`,
      category,
      status,
    });
  });
});
