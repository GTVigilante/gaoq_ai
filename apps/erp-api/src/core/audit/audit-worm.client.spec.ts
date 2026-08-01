import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { HttpAuditWormClient, type AuditWormWriteRequest } from './audit-worm.client.js';

const PAYLOAD_CANONICAL = '{"version":"gaoq.audit.anchor.v1"}';
const PAYLOAD_HASH = createHash('sha256')
  .update(PAYLOAD_CANONICAL, 'utf8')
  .digest('base64url');
const SIGNATURE = Buffer.alloc(64, 1).toString('base64url');

afterEach(() => vi.unstubAllGlobals());

describe('HttpAuditWormClient', () => {
  it('只在端点已配置时报告启用', () => {
    expect(client().isEnabled()).toBe(true);
    expect(client({
      AUDIT_WORM_ENDPOINT: undefined,
      AUDIT_WORM_BEARER_TOKEN: undefined,
    }).isEnabled()).toBe(false);
  });

  it('使用确定性幂等键、有界请求和严格回执写入独立 WORM', async () => {
    const fetchMock = mockJson(receipt());
    const result = await client().write(request());

    expect(result).toMatchObject({ receiptId: 'receipt-001', payloadHash: PAYLOAD_HASH });
    expect(Object.isFrozen(result)).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(call[0])).toBe('https://worm.example.internal/anchors');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(call[1].headers).toEqual(expect.objectContaining({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': PAYLOAD_HASH,
    }));
    const body = call[1].body;
    expect(typeof body).toBe('string');
    expect((call[1].headers as Record<string, string>)['content-length'])
      .toBe(String(Buffer.byteLength(body as string)));
    expect(JSON.parse(body as string)).toEqual(request());
  });

  it('端点与凭据均未配置时写入明确报告禁用', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(client({
      AUDIT_WORM_ENDPOINT: undefined,
      AUDIT_WORM_BEARER_TOKEN: undefined,
    }).write(request())).rejects.toThrow('AUDIT_WORM_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ AUDIT_WORM_ENDPOINT: undefined }],
    [{ AUDIT_WORM_BEARER_TOKEN: undefined }],
    [{ AUDIT_WORM_BEARER_TOKEN: 'short' }],
    [{ AUDIT_WORM_BEARER_TOKEN: `invalid token ${'x'.repeat(32)}` }],
  ])('部分配置或非法凭据失败关闭：%o', async (overrides) => {
    const instance = client(overrides);
    expect(() => instance.isEnabled()).toThrow('AUDIT_WORM_CONFIG_INVALID');
    await expect(instance.write(request())).rejects.toThrow('AUDIT_WORM_CONFIG_INVALID');
  });

  it.each([
    'not-a-url',
    'http://worm.example.internal/anchors',
    'https://user@worm.example.internal/anchors',
    'https://worm.example.internal:8443/anchors',
    'https://worm.example.internal/anchors?token=unsafe',
    'https://worm.example.internal/anchors#fragment',
  ])('运行时拒绝不安全 WORM 端点：%s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(client({ AUDIT_WORM_ENDPOINT: endpoint }).write(request()))
      .rejects.toThrow('AUDIT_WORM_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ payloadCanonical: '' }],
    [{ payloadHash: 'a'.repeat(43) }],
    [{ signingKeyId: 'short' }],
    [{ signature: 'invalid' }],
    [{ signature: `${SIGNATURE.slice(0, -1)}B` }],
    [{ retainUntil: 'invalid-date' }],
  ])('请求必须绑定规范载荷、哈希、签名与保留期：%o', async (overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(client().write(request(overrides)))
      .rejects.toThrow('AUDIT_WORM_REQUEST_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('将网络错误和 HTTP 错误转换为稳定失败码且不读取错误正文', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket secret')));
    await expect(client().write(request())).rejects.toThrow('AUDIT_WORM_NETWORK_ERROR');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream secret', {
      status: 503,
    })));
    await expect(client().write(request())).rejects.toThrow('AUDIT_WORM_HTTP_503');
  });

  it.each([
    [new Response('{}', { status: 200 }), 'AUDIT_WORM_RECEIPT_INVALID'],
    [new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '16385' },
    }), 'AUDIT_WORM_RECEIPT_TOO_LARGE'],
    [new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '-1' },
    }), 'AUDIT_WORM_RECEIPT_TOO_LARGE'],
    [new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'AUDIT_WORM_RECEIPT_INVALID'],
    [new Response('{bad-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'AUDIT_WORM_RECEIPT_INVALID'],
  ])('拒绝非 JSON、声明超限、空体或破损回执：%s', async (response, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(client().write(request())).rejects.toThrow(code);
  });

  it.each([
    [{ payloadHash: 'b'.repeat(43) }, 'AUDIT_WORM_RECEIPT_INVALID'],
    [{ objectVersion: 'contains space' }, 'AUDIT_WORM_RECEIPT_INVALID'],
    [{ retainedUntil: '2030-01-01T00:00:00.000Z' }, 'AUDIT_WORM_RETENTION_INSUFFICIENT'],
    [{
      anchoredAt: '2034-01-01T00:00:00.000Z',
      retainedUntil: '2035-01-01T00:00:00.000Z',
    }, 'AUDIT_WORM_RECEIPT_INVALID'],
    [{
      anchoredAt: '2033-07-21T00:00:00.000Z',
      retainedUntil: '2033-07-20T00:00:00.000Z',
    }, 'AUDIT_WORM_RECEIPT_INVALID'],
  ])('回执必须绑定请求哈希、不可变版本、可信时间和完整保留期：%o', async (
    overrides,
    code,
  ) => {
    mockJson(receipt(overrides));
    await expect(client().write(request())).rejects.toThrow(code);
  });

  it('拒绝未声明长度的超大回执和非法 UTF-8', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'x'.repeat(16_385),
      { headers: { 'content-type': 'application/json' } },
    )));
    await expect(client().write(request())).rejects.toThrow('AUDIT_WORM_RECEIPT_TOO_LARGE');

    const invalidUtf8 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(invalidUtf8, {
      headers: { 'content-type': 'application/json' },
    })));
    await expect(client().write(request())).rejects.toThrow('AUDIT_WORM_RECEIPT_INVALID');
  });
});

function client(overrides: {
  readonly AUDIT_WORM_ENDPOINT?: string | undefined;
  readonly AUDIT_WORM_BEARER_TOKEN?: string | undefined;
} = {}): HttpAuditWormClient {
  const values = {
    AUDIT_WORM_ENDPOINT: 'https://worm.example.internal/anchors',
    AUDIT_WORM_BEARER_TOKEN: 'worm-token-that-is-at-least-32-characters',
    ...overrides,
  };
  return new HttpAuditWormClient({
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>);
}

function request(overrides: Partial<AuditWormWriteRequest> = {}): AuditWormWriteRequest {
  return {
    payloadCanonical: PAYLOAD_CANONICAL,
    payloadHash: PAYLOAD_HASH,
    signingKeyId: 'anchor-key-001',
    signature: SIGNATURE,
    retainUntil: '2033-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-001',
    objectVersion: 'locked-v1',
    payloadHash: PAYLOAD_HASH,
    retainedUntil: '2033-07-20T00:00:00.000Z',
    anchoredAt: '2026-07-21T06:00:00.000Z',
    ...overrides,
  };
}

function mockJson(value: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
