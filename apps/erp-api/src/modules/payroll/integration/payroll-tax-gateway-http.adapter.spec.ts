import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { ProductionExecutionAuthorization } from '../../../core/production-execution/production-execution-authorization.service.js';
import { HttpPayrollTaxGateway } from './payroll-tax-gateway-http.adapter.js';

const FILING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const input = Object.freeze({
  tenantId: 'tenant-001', filingId: FILING_ID, period: '2026-07',
  objectRef: 'worm/payroll-tax/locked-object-001', contentHash: 'a'.repeat(43),
  employeeCount: 2, totalTaxableEarningsMinor: 1_800_000,
  totalWithholdingTaxMinor: 21_000, productionAuthorization: null,
});

function authorization(
  changes?: Partial<ProductionExecutionAuthorization>,
): ProductionExecutionAuthorization {
  return Object.freeze({
    authorizationId: 'authorization-001',
    evidenceId: 'authorization-evidence-001',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    releaseCommitSha: 'c'.repeat(40),
    deploymentManifestHash: `sha256:${'d'.repeat(64)}`,
    ...changes,
  });
}

function config(overrides?: Readonly<Record<string, string | undefined>>) {
  const values: Readonly<Record<string, string | undefined>> = {
    PAYROLL_TAX_GATEWAY_ENDPOINT: 'https://tax-gateway.example.internal/v1/submissions',
    PAYROLL_TAX_GATEWAY_BEARER_TOKEN: 'tax-gateway-token-at-least-32-characters',
    PAYROLL_TAX_GATEWAY_MODE: 'sandbox',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  const submission = {
    tenantId: input.tenantId, filingId: input.filingId, period: input.period,
    objectRef: input.objectRef, contentHash: input.contentHash,
    employeeCount: input.employeeCount,
    totalTaxableEarningsMinor: input.totalTaxableEarningsMinor,
    totalWithholdingTaxMinor: input.totalWithholdingTaxMinor,
  };
  return {
    submissionId: 'tax-submission-001', evidenceId: 'tax-evidence-001', accepted: true,
    ...submission, submissionMode: 'sandbox', ...changes,
  };
}

function productionReceipt(
  item: ProductionExecutionAuthorization,
  changes?: Readonly<Record<string, unknown>>,
) {
  return receipt({
    submissionMode: 'production',
    productionAuthorizationId: item.authorizationId,
    productionAuthorizationEvidenceId: item.evidenceId,
    releaseCommitSha: item.releaseCommitSha,
    deploymentManifestHash: item.deploymentManifestHash,
    ...changes,
  });
}

function jsonResponse(
  value: unknown = receipt(),
  init?: {
    readonly status?: number;
    readonly contentType?: string;
    readonly contentLength?: string;
  },
): Response {
  const body = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : JSON.stringify(value);
  const headers = new Headers();
  if (init?.contentType !== null) {
    headers.set('content-type', init?.contentType ?? 'application/json');
  }
  if (init?.contentLength !== undefined) headers.set('content-length', init.contentLength);
  return new Response(body, { status: init?.status ?? 200, headers });
}

function responseWithReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: { readonly ok?: boolean; readonly status?: number; readonly contentType?: string },
): Response {
  return {
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    headers: new Headers({ 'content-type': options?.contentType ?? 'application/json' }),
    body: { getReader: () => reader },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('Payroll Tax 税务网关 HTTPS Adapter', () => {
  it('只向固定 HTTPS 路径提交 WORM 引用和控制量', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpPayrollTaxGateway(config()).submit(input)).resolves.toEqual({
      submissionId: 'tax-submission-001', evidenceId: 'tax-evidence-001', accepted: true,
      productionAuthorizationEvidenceId: null,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://tax-gateway.example.internal/v1/submissions');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(call[1].body)).toEqual({
      tenantId: input.tenantId, filingId: input.filingId, period: input.period,
      objectRef: input.objectRef, contentHash: input.contentHash,
      employeeCount: input.employeeCount,
      totalTaxableEarningsMinor: input.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: input.totalWithholdingTaxMinor,
      submissionMode: 'sandbox',
    });
    expect(call[1].body).not.toMatch(/employeeId|identityEvidence|certificate|taxpayerId/iu);
    expect(headers).toMatchObject({
      authorization: 'Bearer tax-gateway-token-at-least-32-characters',
      accept: 'application/json', 'cache-control': 'no-store',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(call[1].body)),
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('返回冻结回执且同一业务事实生成相同幂等键', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new HttpPayrollTaxGateway(config());

    const first = await gateway.submit(input);
    await gateway.submit(input);
    expect(Object.isFrozen(first)).toBe(true);
    const headers = fetchMock.mock.calls.map((call) =>
      (call[1] as RequestInit).headers as Readonly<Record<string, string>>);
    expect(headers[0]?.['idempotency-key']).toBe(headers[1]?.['idempotency-key']);
  });

  it('允许规则约束下的负预扣税调整并绑定回执', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt({
      totalWithholdingTaxMinor: -100,
    }))));
    await expect(new HttpPayrollTaxGateway(config()).submit({
      ...input, totalWithholdingTaxMinor: -100,
    })).resolves.toMatchObject({ accepted: true });
  });

  it.each([
    ['tenantId', 'bad tenant'],
    ['filingId', 'filing-not-ulid'],
    ['period', '2026-13'],
    ['objectRef', 'bad ref'],
    ['contentHash', 'not-a-hash'],
    ['employeeCount', 0],
    ['employeeCount', 5_001],
    ['employeeCount', Number.MAX_SAFE_INTEGER + 1],
    ['totalTaxableEarningsMinor', -1],
    ['totalTaxableEarningsMinor', Number.MAX_SAFE_INTEGER + 1],
    ['totalWithholdingTaxMinor', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('拒绝非法请求字段 %s', async (field, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxGateway(config()).submit({
      ...input, [field]: value,
    })).rejects.toThrow('PAYROLL_TAX_GATEWAY_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { PAYROLL_TAX_GATEWAY_ENDPOINT: undefined },
    { PAYROLL_TAX_GATEWAY_BEARER_TOKEN: undefined },
  ])('端点或凭据缺失时失败关闭', async (overrides) => {
    await expect(new HttpPayrollTaxGateway(config(overrides)).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
  });

  it.each([
    'short-token',
    `token with space ${'x'.repeat(32)}`,
    `token-with-newline-${'x'.repeat(32)}\n`,
    'x'.repeat(513),
  ])('运行时拒绝非法税务网关凭据 %s', async (token) => {
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_BEARER_TOKEN: token,
    })).submit(input)).rejects.toThrow('PAYROLL_TAX_GATEWAY_CREDENTIAL_INVALID');
  });

  it('拒绝损坏的提交模式配置', async () => {
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'unsafe',
    })).submit(input)).rejects.toThrow('PAYROLL_TAX_GATEWAY_MODE_INVALID');
  });

  it('sandbox 禁止夹带 production 授权', async () => {
    await expect(new HttpPayrollTaxGateway(config()).submit({
      ...input, productionAuthorization: authorization(),
    })).rejects.toThrow('PAYROLL_TAX_SANDBOX_AUTHORIZATION_FORBIDDEN');
  });

  it.each([
    null,
    authorization({ authorizationId: 'bad id' }),
    authorization({ evidenceId: 'bad id' }),
    authorization({ evidenceId: 'authorization-001' }),
    authorization({ releaseCommitSha: 'x'.repeat(40) }),
    authorization({ deploymentManifestHash: 'sha256:bad' }),
    authorization({ expiresAt: 'not-a-time' }),
    authorization({
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' '),
    }),
    authorization({ expiresAt: new Date(Date.now() + 5_000).toISOString() }),
    authorization({ expiresAt: new Date(Date.now() + 16 * 60_000).toISOString() }),
  ])('production 拒绝无效或非短时独立授权', async (item) => {
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'production',
    })).submit({ ...input, productionAuthorization: item }))
      .rejects.toThrow('PAYROLL_TAX_PRODUCTION_AUTHORIZATION_INVALID');
  });

  it('production 请求与回执精确绑定一次性授权证据', async () => {
    const item = authorization();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(productionReceipt(item), {
      contentType: 'application/vnd.gaoq.tax+json; charset=utf-8',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'production',
    })).submit({ ...input, productionAuthorization: item })).resolves.toEqual({
      submissionId: 'tax-submission-001', evidenceId: 'tax-evidence-001', accepted: true,
      productionAuthorizationEvidenceId: item.evidenceId,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    expect(JSON.parse(call[1].body)).toMatchObject({
      submissionMode: 'production',
      productionAuthorization: item,
    });
  });

  it.each([
    'not-a-url',
    'http://tax-gateway.example.internal/v1/submissions',
    'https://user:secret@tax-gateway.example.internal/v1/submissions',
    'https://tax-gateway.example.internal/v1/submissions?token=unsafe',
    'https://tax-gateway.example.internal/v1/submissions#fragment',
    'https://tax-gateway.example.internal:8443/v1/submissions',
    'https://tax-gateway.example.internal/v1/other',
    'https://tax-gateway.example.internal/v1/submissions/',
  ])('拒绝漂移或不安全端点 %s', async (endpoint) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_ENDPOINT: endpoint,
    })).submit(input)).rejects.toThrow('PAYROLL_TAX_GATEWAY_ENDPOINT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络异常收敛为稳定错误且不透传 cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream-secret-token')));
    try {
      await new HttpPayrollTaxGateway(config()).submit(input);
      throw new Error('测试预期税务网关失败');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('非 2xx 只按状态分类且绝不读取上游正文', async () => {
    const getReader = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, headers: new Headers(),
      body: { getReader },
    }));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_HTTP_503');
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([
    null,
    'text/plain',
    'application/json-evil',
    'application/json; charset=gbk',
    'application/json; profile=unsafe',
  ])('拒绝非规范成功回执 Content-Type', async (contentType) => {
    const response = contentType === null
      ? jsonResponse(receipt())
      : jsonResponse(receipt(), { contentType });
    if (contentType === null) response.headers.delete('content-type');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  });

  it.each(['-1', '+1', '01', '1.0'])(
    '拒绝非规范 Content-Length %s',
    async (contentLength) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), { contentLength })));
      await expect(new HttpPayrollTaxGateway(config()).submit(input))
        .rejects.toThrow('PAYROLL_TAX_GATEWAY_RESPONSE_LENGTH_INVALID');
    },
  );

  it('超出安全整数的 Content-Length 按响应过大失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(receipt(), {
      contentLength: '9007199254740992',
    })));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE');
  });

  it('Content-Length 或实际流超过 16 KiB 时取消并失败关闭', async () => {
    const getReader = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({
        'content-type': 'application/json', 'content-length': '16385',
      }),
      body: { getReader },
    }));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE');
    expect(getReader).not.toHaveBeenCalled();

    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false, value: new Uint8Array(16 * 1024 + 1),
      }),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(reader)));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('空响应体或无法取得读取器时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    }));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => { throw new Error('upstream-reader-secret'); } },
    }));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RESPONSE_READ_ERROR');
  });

  it('读取异常或非法 chunk 收敛为稳定错误并执行取消', async () => {
    for (const read of [
      vi.fn().mockRejectedValue(new Error('upstream-read-secret')),
      vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' }),
    ]) {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const reader = {
        read, cancel, releaseLock: vi.fn(),
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(reader)));
      await expect(new HttpPayrollTaxGateway(config()).submit(input))
        .rejects.toThrow('PAYROLL_TAX_GATEWAY_RESPONSE_READ_ERROR');
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('取消和 releaseLock 失败不得覆盖已确定的结果', async () => {
    const oversized = {
      read: vi.fn().mockResolvedValueOnce({
        done: false, value: new Uint8Array(16 * 1024 + 1),
      }),
      cancel: vi.fn(() => { throw new Error('cancel-secret'); }),
      releaseLock: vi.fn(() => { throw new Error('release-secret'); }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(oversized)));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE');

    const bytes = new TextEncoder().encode(JSON.stringify(receipt()));
    const successful = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: bytes })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(() => { throw new Error('release-secret'); }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithReader(successful)));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .resolves.toMatchObject({ accepted: true });
  });

  it.each([
    new Uint8Array([0xff]),
    '{"broken":',
    '[]',
    'null',
    JSON.stringify(receipt({ unexpected: true })),
    JSON.stringify(receipt({ accepted: false })),
    JSON.stringify(receipt({ tenantId: 'tenant-002' })),
    JSON.stringify(receipt({ filingId: '01J8ZQK7V0A2M4N6P8R0T2W4F2' })),
    JSON.stringify(receipt({ period: '2026-08' })),
    JSON.stringify(receipt({ objectRef: 'worm/payroll-tax/other' })),
    JSON.stringify(receipt({ contentHash: 'b'.repeat(43) })),
    JSON.stringify(receipt({ employeeCount: 3 })),
    JSON.stringify(receipt({ totalTaxableEarningsMinor: 1 })),
    JSON.stringify(receipt({ totalWithholdingTaxMinor: 1 })),
    JSON.stringify(receipt({ evidenceId: 'tax-submission-001' })),
  ])('严格拒绝格式、Schema 或请求绑定错误的回执', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(new HttpPayrollTaxGateway(config()).submit(input))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  });

  it.each([
    { productionAuthorizationId: 'other-authorization' },
    { productionAuthorizationEvidenceId: 'other-evidence' },
    { releaseCommitSha: 'e'.repeat(40) },
    { deploymentManifestHash: `sha256:${'f'.repeat(64)}` },
  ])('production 拒绝授权回显错位', async (changes) => {
    const item = authorization();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      productionReceipt(item, changes),
    )));
    await expect(new HttpPayrollTaxGateway(config({
      PAYROLL_TAX_GATEWAY_MODE: 'production',
    })).submit({ ...input, productionAuthorization: item }))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  });
});
