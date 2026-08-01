import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryImmutableArchive } from './treasury-evidence-http.adapter.js';

const TENANT_ID = 'tenant-001';
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const XML_TEXT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
  '<CstmrCdtTrfInitn><GrpHdr>',
  `<MsgId>${BATCH_ID}</MsgId>`,
  '</GrpHdr><PmtInf>',
  `<PmtInfId>${BATCH_ID}</PmtInfId>`,
  '<CtrlSum>100.00</CtrlSum>',
  '</PmtInf></CstmrCdtTrfInitn></Document>',
].join('');
const XML = Buffer.from(XML_TEXT);
const SHA256 = createHash('sha256').update(XML).digest('base64url');
const OBJECT_KEY = `treasury/${BATCH_ID}/${SHA256}.pain001.xml`;
const TOKEN = 'treasury-worm-token-at-least-32-characters';

function config(overrides?: Readonly<Record<string, unknown>>) {
  const values: Readonly<Record<string, unknown>> = {
    TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://treasury-worm.example.internal/v1/objects',
    TREASURY_WORM_ARCHIVE_BEARER_TOKEN: TOKEN,
    TREASURY_WORM_RETENTION_DAYS: 3_650,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function request() {
  return {
    tenantId: TENANT_ID, batchId: BATCH_ID, objectKey: OBJECT_KEY,
    contentType: 'application/xml' as const, classification: 'L4' as const,
    retentionPolicy: 'payroll_disbursement' as const, sha256: SHA256, bytes: XML,
  };
}

function receipt(overrides?: Readonly<Record<string, unknown>>) {
  return {
    tenantId: TENANT_ID, batchId: BATCH_ID,
    objectRef: 'worm/treasury/locked-object-001', receiptId: 'archive-receipt-001',
    immutable: true, sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 3_650,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown = receipt(),
  options?: Readonly<{ status?: number; contentType?: string; contentLength?: string }>,
): Response {
  const text = JSON.stringify(body);
  const headers = new Headers();
  if (options?.contentType !== '') {
    headers.set('content-type', options?.contentType ?? 'application/json');
  }
  if (options?.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  return new Response(text, { status: options?.status ?? 201, headers });
}

function archive(overrides?: Readonly<Record<string, unknown>>): HttpTreasuryImmutableArchive {
  return new HttpTreasuryImmutableArchive(config(overrides));
}

function stubResponse(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury WORM HTTPS Adapter', () => {
  it('以固定 HTTPS 契约发送 L4 文件并冻结已绑定回执', async () => {
    const fetchMock = stubResponse(jsonResponse());
    const result = await archive().put(request());
    expect(result).toEqual({
      objectRef: 'worm/treasury/locked-object-001',
      receiptId: 'archive-receipt-001', immutable: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://treasury-worm.example.internal/v1/objects');
    expect(call[1]).toMatchObject({
      method: 'POST', redirect: 'error', body: XML,
    });
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'cache-control': 'no-store',
      'content-type': 'application/xml',
      'content-length': String(XML.length),
      'x-content-sha256': SHA256,
      'x-object-key': OBJECT_KEY,
      'x-tenant-id': TENANT_ID,
      'x-batch-id': BATCH_ID,
      'x-data-classification': 'L4',
      'x-retention-policy': 'payroll_disbursement',
      'x-retention-days': '3650',
      'idempotency-key': headers['idempotency-key'],
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(headers['idempotency-key']).not.toContain(TENANT_ID);
    expect(JSON.stringify(headers)).not.toContain(XML_TEXT);
  });

  it('同一归档输入产生确定性幂等键，租户变化会改变幂等域', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(jsonResponse());
    vi.stubGlobal('fetch', fetchMock);
    await archive().put(request());
    await archive().put(request());
    const tenantFetch = vi.fn()
      .mockResolvedValue(jsonResponse(receipt({ tenantId: 'tenant-002' })));
    vi.stubGlobal('fetch', tenantFetch);
    await archive().put({ ...request(), tenantId: 'tenant-002' });
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const tenantCall = tenantFetch.mock.calls[0] as unknown as [string, RequestInit];
    const firstHeaders = firstCall[1].headers as Readonly<Record<string, string>>;
    const secondHeaders = secondCall[1].headers as Readonly<Record<string, string>>;
    const tenantHeaders = tenantCall[1].headers as Readonly<Record<string, string>>;
    expect(firstHeaders['idempotency-key']).toBe(secondHeaders['idempotency-key']);
    expect(tenantHeaders['idempotency-key']).not.toBe(firstHeaders['idempotency-key']);
  });

  it.each([
    ['tenantId', ''],
    ['tenantId', '../tenant'],
    ['tenantId', '租户'],
    ['tenantId', `t${'x'.repeat(128)}`],
    ['tenantId', 123],
    ['batchId', 'batch-001'],
    ['batchId', '81J8ZQK7V0A2M4N6P8R0T2W4F1'],
    ['batchId', '01J8ZQK7V0A2M4N6P8R0T2W4FI'],
    ['bytes', new Uint8Array(XML)],
    ['contentType', 'text/xml'],
    ['classification', 'L3'],
    ['retentionPolicy', 'temporary'],
  ])('运行时拒绝非法输入字段 %s=%s', async (field, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive().put({
      ...request(), [field]: value,
    })).rejects.toThrow('TREASURY_ARCHIVE_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from('<?xml version="1.0" encoding="UTF-8"?>'),
    Buffer.from(XML_TEXT.replace(
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
      '<Document>',
    )),
    Buffer.from(XML_TEXT.replace(`<MsgId>${BATCH_ID}</MsgId>`, '<MsgId>wrong</MsgId>')),
    Buffer.from(XML_TEXT.replace(`<PmtInfId>${BATCH_ID}</PmtInfId>`, '<PmtInfId>wrong</PmtInfId>')),
    Buffer.from(XML_TEXT.replace('</PmtInf></CstmrCdtTrfInitn></Document>', '</Document>')),
    Buffer.from(XML_TEXT.replace('<CstmrCdtTrfInitn>', '<!DOCTYPE x><CstmrCdtTrfInitn>')),
    Buffer.from(XML_TEXT.replace('<CstmrCdtTrfInitn>', '<!ENTITY x "unsafe"><CstmrCdtTrfInitn>')),
    Buffer.from(XML_TEXT.replace('<CstmrCdtTrfInitn>', '<!--unsafe--><CstmrCdtTrfInitn>')),
    Buffer.from(XML_TEXT.replace('<CstmrCdtTrfInitn>', '<?unsafe?><CstmrCdtTrfInitn>')),
    Buffer.from(XML_TEXT.replace(
      `<MsgId>${BATCH_ID}</MsgId>`,
      `<MsgId>wrong</MsgId><!--<MsgId>${BATCH_ID}</MsgId>-->`,
    )),
    Buffer.from([0xff, 0xfe, 0xfd]),
  ])('拒绝非规范、错批次或非 UTF-8 pain.001 正文', async (bytes) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive().put({
      ...request(), bytes,
      sha256: createHash('sha256').update(bytes).digest('base64url'),
    })).rejects.toThrow('TREASURY_PAIN001_FILE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝重复批次绑定标签与超过 8 MiB 的正文', async () => {
    const duplicate = Buffer.from(XML_TEXT.replace(
      `<MsgId>${BATCH_ID}</MsgId>`,
      `<MsgId>${BATCH_ID}</MsgId><MsgId>${BATCH_ID}</MsgId>`,
    ));
    await expect(archive().put({
      ...request(), bytes: duplicate,
      sha256: createHash('sha256').update(duplicate).digest('base64url'),
    })).rejects.toThrow('TREASURY_PAIN001_FILE_INVALID');
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    await expect(archive().put({
      ...request(), bytes: oversized,
      sha256: createHash('sha256').update(oversized).digest('base64url'),
    })).rejects.toThrow('TREASURY_PAIN001_FILE_INVALID');
  });

  it.each([
    ['A'.repeat(43), 'TREASURY_PAIN001_HASH_MISMATCH'],
    ['invalid', 'TREASURY_PAIN001_HASH_MISMATCH'],
  ])('摘要 %s 与正文不一致时失败关闭', async (sha256, code) => {
    await expect(archive().put({ ...request(), sha256 })).rejects.toThrow(code);
  });

  it.each([
    'treasury/not-a-batch/hash.pain001.xml',
    `treasury/${BATCH_ID}/${SHA256}.xml`,
    `treasury/${BATCH_ID}/${'A'.repeat(43)}.pain001.xml`,
    `treasury/01J8ZQK7V0A2M4N6P8R0T2W4F2/${SHA256}.pain001.xml`,
  ])('对象键 %s 未精确绑定批次与摘要时拒绝', async (objectKey) => {
    await expect(archive().put({ ...request(), objectKey }))
      .rejects.toThrow('TREASURY_ARCHIVE_OBJECT_KEY_INVALID');
  });

  it.each([
    { TREASURY_WORM_ARCHIVE_ENDPOINT: undefined },
    { TREASURY_WORM_ARCHIVE_BEARER_TOKEN: undefined },
  ])('基础设施配置缺失时不发起网络请求', async (overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive(overrides).put(request()))
      .rejects.toThrow('TREASURY_IMMUTABLE_ARCHIVE_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'short',
    'x'.repeat(513),
    `${'x'.repeat(31)}\n`,
    `${'x'.repeat(31)} `,
    `${'x'.repeat(31)}中`,
    123,
    null,
  ])('运行时拒绝非法 WORM 凭据且不泄漏凭据内容', async (token) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive({ TREASURY_WORM_ARCHIVE_BEARER_TOKEN: token }).put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_CREDENTIAL_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('允许包含美元符号的可见 ASCII 凭据', async () => {
    const token = `${'x'.repeat(31)}$`;
    const fetchMock = stubResponse(jsonResponse());
    await archive({ TREASURY_WORM_ARCHIVE_BEARER_TOKEN: token }).put(request());
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
  });

  it.each([
    Number.NaN,
    3_649,
    36_501,
    3_650.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('运行时拒绝非法保留期 %s', async (retentionDays) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive({ TREASURY_WORM_RETENTION_DAYS: retentionDays }).put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RETENTION_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-url',
    'http://worm.example.internal/v1/objects',
    'https://user:password@worm.example.internal/v1/objects',
    'https://worm.example.internal:8443/v1/objects',
    'https://worm.example.internal/v1/objects?token=unsafe',
    'https://worm.example.internal/v1/objects#fragment',
    'https://worm.example.internal/v1/object',
    'https://worm.example.internal/v1/objects/',
  ])('端点 %s 不符合固定 HTTPS 契约时拒绝', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(archive({ TREASURY_WORM_ARCHIVE_ENDPOINT: endpoint }).put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('将网络异常稳定化且不暴露上游原因', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream-secret')));
    const error = await archive().put(request()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('TREASURY_WORM_ARCHIVE_UNAVAILABLE');
    expect((error as Error).message).not.toContain('upstream-secret');
  });

  it.each([400, 401, 403, 409, 429, 500, 503])(
    'HTTP %s 失败时不读取响应正文',
    async (status) => {
      const getReader = vi.fn();
      const response = {
        ok: false, status,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader },
      } as unknown as Response;
      stubResponse(response);
      await expect(archive().put(request()))
        .rejects.toThrow(`TREASURY_WORM_ARCHIVE_HTTP_${status}`);
      expect(getReader).not.toHaveBeenCalled();
    },
  );

  it.each([
    'application/json',
    'APPLICATION/JSON',
    'application/json; charset=utf-8',
    'application/problem+json',
    'application/vnd.worm.receipt+json; charset=UTF-8',
  ])('接受受控 JSON Content-Type：%s', async (contentType) => {
    stubResponse(jsonResponse(receipt(), { contentType }));
    await expect(archive().put(request())).resolves.toMatchObject({ immutable: true });
  });

  it.each([
    '',
    'text/json',
    'text/plain',
    'application/jsonp',
    'application/json; charset=gbk',
    'application/json; profile=unsafe',
  ])('拒绝非受控 JSON Content-Type：%s', async (contentType) => {
    stubResponse(jsonResponse(receipt(), { contentType }));
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_INVALID');
  });

  it.each([
    ['租户', { tenantId: 'tenant-002' }],
    ['批次', { batchId: '01J8ZQK7V0A2M4N6P8R0T2W4F2' }],
    ['摘要', { sha256: 'A'.repeat(43) }],
    ['对象键', { objectKey: `treasury/${BATCH_ID}/${'A'.repeat(43)}.pain001.xml` }],
    ['保留期', { retentionDays: 3_649 }],
    ['不可变标志', { immutable: false }],
    ['证据标识独立性', { objectRef: 'archive-receipt-001' }],
    ['未知字段', { accepted: true }],
  ] as const)('回执%s未反向绑定时失败关闭', async (_label, overrides) => {
    stubResponse(jsonResponse(receipt(overrides)));
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_INVALID');
  });

  it.each([
    ['-1', 'TREASURY_ARCHIVE_RESPONSE_LENGTH_INVALID'],
    ['01', 'TREASURY_ARCHIVE_RESPONSE_LENGTH_INVALID'],
    ['1.5', 'TREASURY_ARCHIVE_RESPONSE_LENGTH_INVALID'],
    ['9007199254740992', 'TREASURY_ARCHIVE_RECEIPT_TOO_LARGE'],
    [String(16 * 1024 + 1), 'TREASURY_ARCHIVE_RECEIPT_TOO_LARGE'],
  ])('拒绝不安全 Content-Length %s', async (contentLength, code) => {
    stubResponse(jsonResponse(receipt(), { contentLength }));
    await expect(archive().put(request())).rejects.toThrow(code);
  });

  it('没有响应正文时失败关闭', async () => {
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_INVALID');
  });

  it('读取器创建失败时返回稳定本域错误码', async () => {
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => { throw new Error('upstream-secret'); } },
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RESPONSE_READ_ERROR');
  });

  it.each(['read-error', 'invalid-chunk'])('流式读取异常 %s 会取消并释放读取器', async (kind) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const read = kind === 'read-error'
      ? vi.fn().mockRejectedValue(new Error('upstream-secret'))
      : vi.fn().mockResolvedValueOnce({ done: false, value: 'invalid' });
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RESPONSE_READ_ERROR');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('超过 16 KiB 的流会取消读取且稳定返回过大错误', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(16 * 1024 + 1) });
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('取消和释放失败不得覆盖已确定的过大错误', async () => {
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        read: vi.fn().mockResolvedValueOnce({
          done: false, value: new Uint8Array(16 * 1024 + 1),
        }),
        cancel: () => { throw new Error('cancel-secret'); },
        releaseLock: () => { throw new Error('release-secret'); },
      }) },
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
  });

  it('异步取消失败不得形成未处理拒绝或覆盖本域错误', async () => {
    const response = {
      ok: true, status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        read: vi.fn().mockResolvedValueOnce({
          done: false, value: new Uint8Array(16 * 1024 + 1),
        }),
        cancel: vi.fn().mockRejectedValue(new Error('cancel-secret')),
        releaseLock: vi.fn(),
      }) },
    } as unknown as Response;
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
    await Promise.resolve();
  });

  it.each([
    new Uint8Array([0xff, 0xfe, 0xfd]),
    new TextEncoder().encode('{invalid-json'),
  ])('拒绝非 UTF-8 或非法 JSON 回执', async (value) => {
    const response = new Response(value, {
      status: 201, headers: { 'content-type': 'application/json' },
    });
    stubResponse(response);
    await expect(archive().put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_INVALID');
  });
});
