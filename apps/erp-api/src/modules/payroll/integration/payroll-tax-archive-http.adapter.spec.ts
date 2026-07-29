import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpPayrollTaxImmutableArchive } from './payroll-tax-archive-http.adapter.js';

const TENANT_ID = 'tenant-001';
const FILING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const MANIFEST = Object.freeze({
  schema: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
  filingId: FILING_ID,
  tenantId: TENANT_ID,
  period: '2026-07',
  payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
  currency: 'CNY',
  employeeCount: 1,
  totalTaxableEarningsMinor: 1_000_000,
  totalWithholdingTaxMinor: 20_000,
  lines: [],
});
const BYTES = Buffer.from(JSON.stringify(MANIFEST), 'utf8');
const HASH = createHash('sha256').update(BYTES).digest('base64url');
const OBJECT_KEY = `payroll-tax/${FILING_ID}/${HASH}.json`;

function config(
  overrides?: Readonly<Record<string, string | number | undefined>>,
) {
  const values: Readonly<Record<string, string | number | undefined>> = {
    PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'https://tax-worm.example.internal/v1/objects',
    PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: 'tax-worm-token-at-least-32-characters',
    PAYROLL_TAX_WORM_RETENTION_DAYS: 3_650,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function request(changes?: Readonly<Record<string, unknown>>) {
  return {
    tenantId: TENANT_ID, filingId: FILING_ID,
    objectKey: OBJECT_KEY, sha256: HASH, bytes: BYTES,
    ...changes,
  } as {
    readonly tenantId: string;
    readonly filingId: string;
    readonly objectKey: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  };
}

function requestFor(
  bytes: Buffer,
  options?: { readonly tenantId?: string; readonly filingId?: string },
) {
  const tenantId = options?.tenantId ?? TENANT_ID;
  const filingId = options?.filingId ?? FILING_ID;
  const sha256 = createHash('sha256').update(bytes).digest('base64url');
  return {
    tenantId, filingId, bytes, sha256,
    objectKey: `payroll-tax/${filingId}/${sha256}.json`,
  };
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  return {
    objectRef: 'worm/payroll-tax/locked-object-001',
    evidenceId: 'tax-worm-evidence-001',
    immutable: true, sha256: HASH, objectKey: OBJECT_KEY, retentionDays: 3_650,
    ...changes,
  };
}

function jsonResponse(
  value: unknown = receipt(),
  options?: {
    readonly status?: number;
    readonly contentType?: string;
    readonly contentLength?: string;
  },
): Response {
  const body = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : JSON.stringify(value);
  const headers = new Headers({ 'content-type': options?.contentType ?? 'application/json' });
  if (options?.contentLength !== undefined) headers.set('content-length', options.contentLength);
  return new Response(body, { status: options?.status ?? 200, headers });
}

function responseWithReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => reader },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('Payroll Tax WORM HTTPS Adapter', () => {
  it('只向固定 HTTPS 路径发送 L4 清单并绑定十年不可变回执', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request())).resolves.toEqual({
      objectRef: 'worm/payroll-tax/locked-object-001',
      evidenceId: 'tax-worm-evidence-001', immutable: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://tax-worm.example.internal/v1/objects');
    expect(call[1]).toMatchObject({
      method: 'POST', redirect: 'error', body: BYTES,
    });
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(headers).toMatchObject({
      authorization: 'Bearer tax-worm-token-at-least-32-characters',
      accept: 'application/json', 'cache-control': 'no-store',
      'content-type': 'application/json',
      'content-length': String(BYTES.length),
      'x-object-key': OBJECT_KEY, 'x-content-sha256': HASH,
      'x-data-classification': 'L4', 'x-retention-policy': 'payroll_tax_filing',
      'x-retention-days': '3650',
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(headers)).not.toContain('CN_IIT_WITHHOLDING_MANIFEST_V1');
  });

  it('返回冻结回执且相同清单使用确定性幂等键', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const archive = new HttpPayrollTaxImmutableArchive(config());

    const first = await archive.put(request());
    await archive.put(request());
    expect(Object.isFrozen(first)).toBe(true);
    const headers = fetchMock.mock.calls.map((call) =>
      (call[1] as RequestInit).headers as Readonly<Record<string, string>>);
    expect(headers[0]?.['idempotency-key']).toBe(headers[1]?.['idempotency-key']);
  });

  it.each([
    { tenantId: 'bad tenant' },
    { filingId: 'filing-not-ulid' },
    { bytes: Buffer.from('x') },
    { bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
    { sha256: 'A'.repeat(43) },
    { objectKey: 'payroll-tax/wrong/object.json' },
  ])('在网络调用前拒绝非法归档输入', async (changes) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request(changes)))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('同一独立 WORM 允许受控的工资调整税务更正规范正文', async () => {
    const bytes = Buffer.from(
      `{"schema":"CN_IIT_WITHHOLDING_CORRECTION_V1","correctionFilingId":"${FILING_ID}","tenantId":"tenant-001"}`,
      'utf8',
    );
    const sha256 = createHash('sha256').update(bytes).digest('base64url');
    const objectKey = `payroll-tax/${FILING_ID}/${sha256}.json`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt({
      sha256,
      objectKey,
      objectRef: 'worm/payroll-tax/correction-001',
      evidenceId: 'tax-correction-worm-evidence-001',
    })), { status: 201, headers: { 'content-type': 'application/json' } })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put({
      tenantId: 'tenant-001',
      filingId: FILING_ID,
      objectKey,
      sha256,
      bytes,
    })).resolves.toEqual({
      objectRef: 'worm/payroll-tax/correction-001',
      evidenceId: 'tax-correction-worm-evidence-001',
      immutable: true,
    });
  });

  it.each([
    Buffer.from([0xff, 0xff]),
    Buffer.from('{"broken":', 'utf8'),
    Buffer.from('[]', 'utf8'),
    Buffer.from(JSON.stringify({ ...MANIFEST, schema: 'OTHER' }), 'utf8'),
    Buffer.from(JSON.stringify({ ...MANIFEST, tenantId: 'tenant-002' }), 'utf8'),
    Buffer.from(JSON.stringify({
      ...MANIFEST, filingId: '01J8ZQK7V0A2M4N6P8R0T2W4F2',
    }), 'utf8'),
  ])('严格解析 UTF-8/JSON 并绑定清单租户和申报标识', async (bytes) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(requestFor(bytes)))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_MANIFEST_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: undefined },
    { PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: undefined },
  ])('WORM 端点或凭据缺失时失败关闭', async (overrides) => {
    await expect(new HttpPayrollTaxImmutableArchive(config(overrides)).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
  });

  it.each([
    'short-token',
    `token with space ${'x'.repeat(32)}`,
    `token-with-control-${'x'.repeat(32)}\u007f`,
    'x'.repeat(513),
  ])('运行时拒绝非法 WORM 凭据', async (token) => {
    await expect(new HttpPayrollTaxImmutableArchive(config({
      PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: token,
    })).put(request())).rejects.toThrow('PAYROLL_TAX_ARCHIVE_CREDENTIAL_INVALID');
  });

  it.each([3_649, 36_501, 3_650.5, Number.NaN])(
    '运行时拒绝非法保留期 %s',
    async (retentionDays) => {
      await expect(new HttpPayrollTaxImmutableArchive(config({
        PAYROLL_TAX_WORM_RETENTION_DAYS: retentionDays,
      })).put(request())).rejects.toThrow('PAYROLL_TAX_ARCHIVE_RETENTION_INVALID');
    },
  );

  it.each([
    'not-a-url',
    'http://tax-worm.example.internal/v1/objects',
    'https://user:secret@tax-worm.example.internal/v1/objects',
    'https://tax-worm.example.internal/v1/objects?token=unsafe',
    'https://tax-worm.example.internal/v1/objects#fragment',
    'https://tax-worm.example.internal:8443/v1/objects',
    'https://tax-worm.example.internal/v1/other',
    'https://tax-worm.example.internal/v1/objects/',
  ])('拒绝漂移或不安全 WORM 端点 %s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxImmutableArchive(config({
      PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: endpoint,
    })).put(request())).rejects.toThrow('PAYROLL_TAX_ARCHIVE_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络异常不泄露上游 cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('worm-upstream-secret')));
    try {
      await new HttpPayrollTaxImmutableArchive(config()).put(request());
      throw new Error('测试预期 WORM 调用失败');
    } catch (error) {
      expect((error as Error).message).toBe('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('非 2xx 不读取 WORM 正文', async () => {
    const getReader = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, headers: new Headers(),
      body: { getReader },
    }));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_HTTP_429');
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([
    'text/plain',
    'application/json-evil',
    'application/json; charset=gbk',
  ])('拒绝非规范 WORM 回执 Content-Type', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), { contentType })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
  });

  it('接受规范 vendor JSON 和 UTF-8 charset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), {
      contentType: 'application/vnd.gaoq.worm+json; charset=UTF-8',
    })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .resolves.toMatchObject({ immutable: true });
  });

  it.each(['-1', '01', '1.0'])(
    '拒绝非规范 WORM Content-Length %s',
    async (contentLength) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), {
        contentLength,
      })));
      await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
        .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RESPONSE_LENGTH_INVALID');
    },
  );

  it('超出安全整数的 WORM Content-Length 按响应过大失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), {
      contentLength: '9007199254740992',
    })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE');
  });

  it('Content-Length 和流式读取均实施 16 KiB 上限', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), {
      contentLength: '16385',
    })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE');

    const cancel = vi.fn().mockRejectedValue(new Error('cancel-secret'));
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false, value: new Uint8Array(16 * 1024 + 1),
      }),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(reader)));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('读取失败收敛为 WORM 稳定错误', async () => {
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('read-secret')),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(() => { throw new Error('release-secret'); }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(reader)));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RESPONSE_READ_ERROR');
  });

  it.each([
    new Uint8Array([0xff]),
    '{"broken":',
    '[]',
    JSON.stringify(receipt({ unexpected: true })),
    JSON.stringify(receipt({ immutable: false })),
    JSON.stringify(receipt({ sha256: 'B'.repeat(43) })),
    JSON.stringify(receipt({ objectKey: `payroll-tax/${FILING_ID}/${'B'.repeat(43)}.json` })),
    JSON.stringify(receipt({ retentionDays: 3_649 })),
    JSON.stringify(receipt({ objectRef: 'bad ref' })),
    JSON.stringify(receipt({ evidenceId: 'bad evidence id' })),
    JSON.stringify(receipt({
      objectRef: 'same-evidence-id', evidenceId: 'same-evidence-id',
    })),
  ])('拒绝格式、Schema 或业务绑定错误的 WORM 回执', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(request()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
  });
});
