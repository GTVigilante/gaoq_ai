import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  FetchOpApprovalHttpClient,
  type OpApprovalHttpRequest,
} from './op-approval-http.client.js';

const PATH = '/erp/v1/approval-results/approval-event-001';
const BODY = '{"result":"approved"}';
const MAX_RESPONSE_BYTES = 256 * 1024;

function client(baseUrl: string | null = 'https://op.example.net') {
  return new FetchOpApprovalHttpClient(new ConfigService<AppEnvironment, true>({
    ...(baseUrl === null ? {} : { OP_API_BASE_URL: baseUrl }),
  } as AppEnvironment));
}

function headers(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-gaoq-erp-client-id': 'erp-client-001',
    'x-gaoq-erp-external-tenant-id': 'op-tenant-001',
    'x-gaoq-erp-timestamp': '1785225600000',
    'x-gaoq-erp-nonce': 'ABCDEFGHIJKLMNOPQRSTUV',
    'x-gaoq-erp-idempotency-key': '01K00000000000000000000001',
    'x-gaoq-erp-signature-algorithm': 'hmac-sha256',
    'x-gaoq-erp-signature': '0'.repeat(64),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function request(
  overrides: Partial<OpApprovalHttpRequest> = {},
): OpApprovalHttpRequest {
  return {
    path: PATH,
    headers: headers(),
    body: BODY,
    ...overrides,
  };
}

function okResponse(
  body: string | null = JSON.stringify({
    code: 'OK',
    data: {
      externalEventId: 'approval-event-001',
      approvalInstanceId: '01K00000000000000000000001',
      approvalVersion: 3,
    },
  }),
  headersInput: Readonly<Record<string, string>> = {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': 'request-001',
  },
): Response {
  return new Response(body, { status: 200, headers: headersInput });
}

describe('FetchOpApprovalHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('只向固定 HTTPS 根域和审批结果 PUT 路径发送规范请求', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().put(request())).resolves.toEqual({
      status: 200,
      requestId: 'request-001',
      body: {
        code: 'OK',
        data: {
          externalEventId: 'approval-event-001',
          approvalInstanceId: '01K00000000000000000000001',
          approvalVersion: 3,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://op.example.net${PATH}`),
      expect.objectContaining({
        method: 'PUT',
        redirect: 'error',
        headers: { accept: 'application/json', ...headers() },
        body: BODY,
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('OP 根地址缺失时失败关闭', async () => {
    await expect(client(null).put(request())).rejects.toMatchObject({
      code: 'OP_API_UNAVAILABLE',
      category: 'retryable',
    });
  });

  it.each([
    '//attacker.example/x',
    'relative',
    '/erp/v1/approval-results/bad',
    '/erp/v1/approval-results/approval..event',
    '/erp/v1/approval-results/approval-event-001?query=1',
  ])('拒绝非协议路径 %s', async (path) => {
    await expect(client().put(request({ path }))).rejects.toMatchObject({
      code: 'OP_APPROVAL_PATH_INVALID',
      category: 'business',
    });
  });

  it.each([
    'not-a-url',
    'http://op.example.net',
    'https://user@op.example.net',
    'https://user:secret@op.example.net',
    'https://op.example.net/base',
    'https://op.example.net?query=1',
    'https://op.example.net#fragment',
    'https://op.example.net:8443',
  ])('拒绝非标准 HTTPS 根地址 %s', async (baseUrl) => {
    await expect(client(baseUrl).put(request())).rejects.toMatchObject({
      code: 'OP_APPROVAL_BASE_URL_INVALID',
      category: 'business',
    });
  });

  it('拒绝缺失、额外、重复、超长和含控制字符的 Header', async () => {
    const invalidHeaders = [
      headers({ 'x-gaoq-erp-signature': undefined }),
      headers({ host: 'attacker.example' }),
      headers({ 'X-GAOQ-ERP-CLIENT-ID': 'duplicate-client' }),
      headers({ 'x-gaoq-erp-client-id': 'x'.repeat(2_049) }),
      headers({ 'x-gaoq-erp-client-id': 'client\ninjected' }),
    ];
    for (const invalid of invalidHeaders) {
      await expect(client().put(request({ headers: invalid }))).rejects.toMatchObject({
        code: 'OP_APPROVAL_HEADER_INVALID',
        category: 'business',
      });
    }
  });

  it.each([
    ['content-type', 'application/json'],
    ['x-gaoq-erp-client-id', '-invalid'],
    ['x-gaoq-erp-external-tenant-id', ''],
    ['x-gaoq-erp-timestamp', '178522560000'],
    ['x-gaoq-erp-nonce', 'short'],
    ['x-gaoq-erp-idempotency-key', ' invalid'],
    ['x-gaoq-erp-signature-algorithm', 'HMAC-SHA256'],
    ['x-gaoq-erp-signature', 'A'.repeat(64)],
  ])('拒绝不符合签名协议的 Header %s', async (name, value) => {
    await expect(client().put(request({
      headers: headers({ [name]: value }),
    }))).rejects.toMatchObject({ code: 'OP_APPROVAL_HEADER_INVALID' });
  });

  it.each([
    '',
    'null',
    '[]',
    '"approved"',
    '{{',
  ])('拒绝非有界 JSON 对象正文 %s', async (body) => {
    await expect(client().put(request({ body }))).rejects.toMatchObject({
      code: 'OP_APPROVAL_REQUEST_INVALID',
      category: 'business',
    });
  });

  it('拒绝超过 16 KiB 的出站正文', async () => {
    await expect(client().put(request({
      body: JSON.stringify({ value: 'x'.repeat(16 * 1024) }),
    }))).rejects.toMatchObject({ code: 'OP_APPROVAL_REQUEST_INVALID' });
  });

  it('网络异常收敛为稳定错误且不保留敏感 cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('secret-signature private-network-detail'),
    ));

    const error = await client().put(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'OP_APPROVAL_NETWORK_ERROR',
      category: 'retryable',
    });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('secret-signature');
  });

  it.each([
    ['not-a-number', 'OP_APPROVAL_RESPONSE_LENGTH_INVALID'],
    ['-1', 'OP_APPROVAL_RESPONSE_LENGTH_INVALID'],
    [String(MAX_RESPONSE_BYTES + 1), 'OP_APPROVAL_RESPONSE_TOO_LARGE'],
    ['9'.repeat(30), 'OP_APPROVAL_RESPONSE_TOO_LARGE'],
  ])('拒绝 Content-Length %s', async (contentLength, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('{}', {
      'content-type': 'application/json',
      'content-length': contentLength,
    })));

    await expect(client().put(request())).rejects.toMatchObject({ code });
  });

  it('无 Content-Length 的超大流式响应仍取消读取并失败关闭', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(MAX_RESPONSE_BYTES + 1),
      }),
      cancel,
      releaseLock,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    }));

    await expect(client().put(request())).rejects.toMatchObject({
      code: 'OP_APPROVAL_RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each([
    ['读取失败', vi.fn().mockRejectedValue(new Error('secret read detail'))],
    ['非法分块', vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' })],
  ])('%s 时取消读取并返回稳定错误', async (_name, read) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));

    const error = await client().put(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'OP_APPROVAL_RESPONSE_READ_ERROR',
    });
    expect(error).not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('读取器清理异常不覆盖成功结果', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(() => {
        throw new Error('release failed');
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: { getReader: () => reader },
    }));

    await expect(client().put(request())).resolves.toEqual({
      status: 200,
      requestId: undefined,
      body: {},
    });
  });

  it('拒绝非严格 UTF-8、非 JSON Content-Type 和非法 JSON', async () => {
    const invalidUtf8Reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([0xc3, 0x28]) })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => invalidUtf8Reader },
    })
      .mockResolvedValueOnce(okResponse('{}', { 'content-type': 'text/plain' }))
      .mockResolvedValueOnce(okResponse('{invalid', { 'content-type': 'application/json' })));

    await expect(client().put(request())).rejects.toMatchObject({
      code: 'OP_APPROVAL_RESPONSE_INVALID',
    });
    await expect(client().put(request())).rejects.toMatchObject({
      code: 'OP_APPROVAL_RESPONSE_CONTENT_TYPE_INVALID',
    });
    await expect(client().put(request())).rejects.toMatchObject({
      code: 'OP_APPROVAL_RESPONSE_INVALID',
    });
  });

  it('支持标准和 +json 响应类型，无正文时返回空对象', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(okResponse('{}', {
        'content-type': 'application/problem+json;charset=utf-8',
      }))
      .mockResolvedValueOnce(okResponse(null, {})));

    await expect(client().put(request())).resolves.toEqual({
      status: 200,
      requestId: undefined,
      body: {},
    });
    await expect(client().put(request())).resolves.toEqual({
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
  ] as const)('HTTP %s 映射为 %s 且忽略敏感错误正文', async (status, category) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'secret upstream response is not json',
      { status, headers: { 'content-type': 'text/html' } },
    )));

    const error = await client().put(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: `OP_APPROVAL_HTTP_${status}`,
      category,
      status,
    });
    expect(String(error)).not.toContain('secret upstream');
  });

  it('上游 requestId 仅接受 1–128 个可见 ASCII 字符', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(okResponse('{}', {
        'content-type': 'application/json',
        'x-request-id': 'contains space',
      }))
      .mockResolvedValueOnce(okResponse('{}', {
        'content-type': 'application/json',
        'x-request-id': 'x'.repeat(129),
      })));

    await expect(client().put(request())).resolves.toMatchObject({ requestId: undefined });
    await expect(client().put(request())).resolves.toMatchObject({ requestId: undefined });
  });
});
