import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBrowserSession,
  ErpApiError,
  erpDownload,
  isDefinitiveWriteRejection,
  parseApiEnvelope,
  strongEtag,
} from './api-client.js';

const accessToken = 'a'.repeat(40);
const successEnvelope = (data: unknown) => ({
  code: 'SUCCESS', message: '成功', data,
  traceId: 'trace-web-001', timestamp: '2026-07-22T00:00:00.000Z',
});

describe('ERP Web API Client', () => {
  beforeEach(() => {
    clearBrowserSession();
    vi.restoreAllMocks();
  });
  it('只接受带 traceId 的统一成功信封', () => {
    const value = parseApiEnvelope<{ readonly count: number }>({
      code: 'SUCCESS', message: '成功', data: { count: 3 },
      traceId: 'trace-web-001', timestamp: '2026-07-22T00:00:00.000Z',
    });
    expect(value.data.count).toBe(3);
    expect(value.traceId).toBe('trace-web-001');
  });

  it('拒绝缺失 traceId 或时间戳的响应', () => {
    expect(() => parseApiEnvelope({ code: 'SUCCESS', message: '成功', data: [] }))
      .toThrowError(expect.objectContaining({ code: 'API_RESPONSE_INVALID' }));
  });

  it('生成强 ETag 并拒绝非法版本', () => {
    expect(strongEtag(7)).toBe('"7"');
    expect(() => strongEtag(0)).toThrowError('ETAG_VERSION_INVALID');
  });

  it('错误类型不携带响应正文或访问令牌', () => {
    const error = new ErpApiError('AUTH_REQUIRED', '请登录', 'trace-web-002', 401);
    expect(error).toMatchObject({
      name: 'ErpApiError', code: 'AUTH_REQUIRED', message: '请登录',
      traceId: 'trace-web-002', status: 401,
    });
    expect(JSON.stringify(error)).not.toContain('accessToken');
  });

  it('只把处理中、超时、限流和服务端故障视为可复用重试', () => {
    expect(isDefinitiveWriteRejection(new ErpApiError('IDEMPOTENCY_IN_PROGRESS', '处理中', null, 409))).toBe(false);
    expect(isDefinitiveWriteRejection(new ErpApiError('APPROVAL_VERSION_CONFLICT', '版本冲突', null, 409))).toBe(true);
    expect(isDefinitiveWriteRejection(new ErpApiError('IDEMPOTENCY_KEY_REUSED', '键已被其他请求使用', null, 409))).toBe(true);
    expect(isDefinitiveWriteRejection(new ErpApiError('RATE_LIMITED', '稍后重试', null, 429))).toBe(false);
    expect(isDefinitiveWriteRejection(new ErpApiError('UPSTREAM_FAILED', '服务异常', null, 503))).toBe(false);
  });

  it('通过内存访问令牌下载类型和大小均受控的文件', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(successEnvelope({
        accessToken, tokenType: 'Bearer', expiresIn: 300, scope: 'erp:marketing:lead:export',
      })), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('id,name\nlead-001,测试\n', {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-length': '25' },
      }));

    const file = await erpDownload('/api/marketing-cms/leads/export', 'text/csv', 1024);

    expect(file.type).toBe('text/csv');
    expect(file.size).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store',
    }));
    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`);
  });

  it('拒绝类型不符、超出声明上限或空文件', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(successEnvelope({
        accessToken, tokenType: 'Bearer', expiresIn: 300, scope: 'erp:marketing:lead:export',
      })), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('secret', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '2048' },
      }));

    await expect(erpDownload('/api/marketing-cms/leads/export', 'text/csv', 1024))
      .rejects.toMatchObject({ code: 'DOWNLOAD_RESPONSE_INVALID', status: 502 });
  });
});
