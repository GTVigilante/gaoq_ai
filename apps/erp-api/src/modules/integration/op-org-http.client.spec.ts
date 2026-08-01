import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { FetchOpOrgHttpClient } from './op-org-http.client.js';

function client(baseUrl = 'https://op.example.net') {
  return new FetchOpOrgHttpClient(new ConfigService<AppEnvironment, true>({
    OP_API_BASE_URL: baseUrl,
  } as AppEnvironment));
}

describe('FetchOpOrgHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('只向配置的 HTTPS 根域发送适配器签名的原始正文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'OK', data: { externalId: 'department-001' } }),
      { status: 200, headers: { 'x-request-id': 'request-001' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const body = '{"fixed":true}';
    const response = await client().request({
      method: 'PUT', path: '/erp/v1/org/departments/department-001',
      headers: { 'content-type': 'application/json', 'x-gaoq-erp-signature': '0'.repeat(64) },
      body,
    });
    expect(response.requestId).toBe('request-001');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://op.example.net/erp/v1/org/departments/department-001'),
      expect.objectContaining({ method: 'PUT', body, redirect: 'error' }),
    );
  });

  it('拒绝路径逃逸、危险请求头和非标准 HTTPS 根地址', async () => {
    await expect(client().request({
      method: 'GET', path: '//attacker.example/snapshot', headers: {},
    })).rejects.toThrow('OP_ORG_PATH_INVALID');
    await expect(client().request({
      method: 'GET', path: '/erp/v1/org/snapshot', headers: { Host: 'attacker.example' },
    })).rejects.toThrow('OP_ORG_HEADER_INVALID');
    await expect(client('http://op.example.net').request({
      method: 'GET', path: '/erp/v1/org/snapshot', headers: {},
    })).rejects.toThrow('OP_ORG_BASE_URL_INVALID');
  });

  it('对端省略 Content-Length 时仍在流式读取阶段限制响应大小', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))));
    await expect(client().request({
      method: 'GET', path: '/erp/v1/org/snapshot', headers: {},
    })).rejects.toMatchObject({ code: 'OP_ORG_RESPONSE_TOO_LARGE' });
  });
});
