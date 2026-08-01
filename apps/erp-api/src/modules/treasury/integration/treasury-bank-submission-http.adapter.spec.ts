import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryBankSubmissionGateway } from './treasury-bank-submission-http.adapter.js';

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const ENDPOINT = 'https://bank-gateway.example.internal/v1/submissions';
const TOKEN = 'bank-gateway-token-at-least-32-characters';
const input = Object.freeze({
  tenantId: 'tenant-001',
  batchId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  objectRef: 'worm/treasury/locked-object-001',
  fileHash: 'a'.repeat(43),
  lineCount: 2,
  totalMinor: 1_839_600,
  productionAuthorization: null,
});
const productionAuthorization = Object.freeze({
  authorizationId: 'authorization-001',
  evidenceId: 'authorization-evidence-001',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  releaseCommitSha: 'c'.repeat(40),
  deploymentManifestHash: `sha256:${'d'.repeat(64)}`,
});

function config(
  overrides: Readonly<Record<string, string | undefined>> = {},
): ConfigService<AppEnvironment, true> {
  const values: Readonly<Record<string, string | undefined>> = {
    TREASURY_BANK_SUBMISSION_ENDPOINT: ENDPOINT,
    TREASURY_BANK_SUBMISSION_BEARER_TOKEN: TOKEN,
    TREASURY_BANK_SUBMISSION_MODE: 'sandbox',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as
    ConfigService<AppEnvironment, true>;
}

function gateway(
  overrides: Readonly<Record<string, string | undefined>> = {},
): HttpTreasuryBankSubmissionGateway {
  return new HttpTreasuryBankSubmissionGateway(config(overrides));
}

function receipt(changes: Readonly<Record<string, unknown>> = {}) {
  return {
    submissionId: 'bank-submission-001',
    evidenceId: 'bank-evidence-001',
    accepted: true,
    batchId: input.batchId,
    objectRef: input.objectRef,
    fileHash: input.fileHash,
    lineCount: input.lineCount,
    totalMinor: input.totalMinor,
    submissionMode: 'sandbox',
    ...changes,
  };
}

function okResponse(
  body: string = JSON.stringify(receipt()),
  headers: Readonly<Record<string, string>> = {
    'content-type': 'application/json; charset=utf-8',
  },
): Response {
  return new Response(body, { status: 202, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury 银行提交 HTTPS Adapter', () => {
  it('只向固定 HTTPS 路径提交 WORM 引用与控制量', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway().submit(input)).resolves.toEqual({
      submissionId: 'bank-submission-001',
      evidenceId: 'bank-evidence-001',
      accepted: true,
      productionAuthorizationEvidenceId: null,
    });
    const call = fetchMock.mock.calls[0];
    if (call === undefined || typeof call[1]?.body !== 'string') {
      throw new Error('测试请求体必须是 JSON 字符串');
    }
    expect(call[0]).toBe(ENDPOINT);
    expect(call[1]).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: call[1].body,
    }));
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(call[1].body)).toEqual({
      tenantId: input.tenantId,
      batchId: input.batchId,
      objectRef: input.objectRef,
      fileHash: input.fileHash,
      lineCount: input.lineCount,
      totalMinor: input.totalMinor,
      submissionMode: 'sandbox',
    });
    expect(call[1].body).not.toMatch(/creditor|debtor|account|xml/u);
    const requestHeaders = call[1].headers as Record<string, string>;
    expect(requestHeaders).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(call[1].body)),
      'idempotency-key': requestHeaders['idempotency-key'],
    });
    expect(requestHeaders['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('相同业务对象生成相同幂等键，控制量变化后生成不同键', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse(JSON.stringify(receipt({
        totalMinor: input.totalMinor + 1,
      }))));
    vi.stubGlobal('fetch', fetchMock);

    await gateway().submit(input);
    await gateway().submit(input);
    await gateway().submit({ ...input, totalMinor: input.totalMinor + 1 });

    const keys = fetchMock.mock.calls.map((call) =>
      (call[1]?.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    ['tenantId', ''],
    ['batchId', ' invalid'],
    ['objectRef', '../secret'],
    ['fileHash', 'short'],
    ['lineCount', 0],
    ['lineCount', 5_001],
    ['lineCount', 1.5],
    ['totalMinor', 0],
    ['totalMinor', Number.MAX_SAFE_INTEGER + 1],
  ])('拒绝非法输入 %s', async (field, value) => {
    await expect(gateway().submit({
      ...input,
      [field]: value,
    })).rejects.toThrow('TREASURY_BANK_SUBMISSION_INPUT_INVALID');
  });

  it('端点或凭据缺失时失败关闭', async () => {
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_ENDPOINT: undefined,
    }).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_UNAVAILABLE');
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: undefined,
    }).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_UNAVAILABLE');
  });

  it.each([
    '',
    'short',
    'x'.repeat(513),
    `valid-prefix\n${'x'.repeat(32)}`,
  ])('拒绝非法银行网关凭据', async (token) => {
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_BEARER_TOKEN: token,
    }).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_CREDENTIAL_INVALID');
  });

  it.each([
    'invalid',
    'http://bank.example/v1/submissions',
    'https://user@bank.example/v1/submissions',
    'https://user:password@bank.example/v1/submissions',
    'https://bank.example:8443/v1/submissions',
    'https://bank.example/v1/submissions?token=unsafe',
    'https://bank.example/v1/submissions#fragment',
    'https://bank.example/v1/other',
    'https://bank.example/v1/submissions/',
  ])('拒绝非固定标准 HTTPS 提交端点 %s', async (endpoint) => {
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_ENDPOINT: endpoint,
    }).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_ENDPOINT_INVALID');
  });

  it('拒绝非法提交模式', async () => {
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_MODE: 'unexpected',
    }).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_MODE_INVALID');
  });

  it('sandbox 禁止携带生产执行授权', async () => {
    await expect(gateway().submit({
      ...input,
      productionAuthorization,
    })).rejects.toThrow('TREASURY_BANK_SANDBOX_AUTHORIZATION_FORBIDDEN');
  });

  it.each([
    null,
    { ...productionAuthorization, authorizationId: '' },
    { ...productionAuthorization, evidenceId: '' },
    {
      ...productionAuthorization,
      authorizationId: productionAuthorization.evidenceId,
    },
    { ...productionAuthorization, releaseCommitSha: 'C'.repeat(40) },
    { ...productionAuthorization, deploymentManifestHash: 'invalid' },
    { ...productionAuthorization, expiresAt: 'invalid' },
    {
      ...productionAuthorization,
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    },
    {
      ...productionAuthorization,
      expiresAt: new Date(Date.now() + 16 * 60_000).toISOString(),
    },
  ])('production 拒绝非法短时授权 %#', async (authorization) => {
    await expect(gateway({
      TREASURY_BANK_SUBMISSION_MODE: 'production',
    }).submit({
      ...input,
      productionAuthorization: authorization,
    })).rejects.toThrow('TREASURY_BANK_PRODUCTION_AUTHORIZATION_INVALID');
  });

  it('production 携带短时授权且要求上游精确回显', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse(JSON.stringify(receipt({
      submissionMode: 'production',
      productionAuthorizationId: productionAuthorization.authorizationId,
      productionAuthorizationEvidenceId: productionAuthorization.evidenceId,
      releaseCommitSha: productionAuthorization.releaseCommitSha,
      deploymentManifestHash: productionAuthorization.deploymentManifestHash,
    }))));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway({
      TREASURY_BANK_SUBMISSION_MODE: 'production',
    }).submit({
      ...input,
      productionAuthorization,
    })).resolves.toEqual({
      submissionId: 'bank-submission-001',
      evidenceId: 'bank-evidence-001',
      accepted: true,
      productionAuthorizationEvidenceId: productionAuthorization.evidenceId,
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('生产请求体缺失');
    expect(JSON.parse(body)).toEqual({
      tenantId: input.tenantId,
      batchId: input.batchId,
      objectRef: input.objectRef,
      fileHash: input.fileHash,
      lineCount: input.lineCount,
      totalMinor: input.totalMinor,
      submissionMode: 'production',
      productionAuthorization,
    });
  });

  it.each([
    ['productionAuthorizationId', 'another-authorization'],
    ['productionAuthorizationEvidenceId', 'another-evidence'],
    ['releaseCommitSha', 'e'.repeat(40)],
    ['deploymentManifestHash', `sha256:${'f'.repeat(64)}`],
  ])('production 拒绝未精确回显的授权字段 %s', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(JSON.stringify(receipt({
      submissionMode: 'production',
      productionAuthorizationId: productionAuthorization.authorizationId,
      productionAuthorizationEvidenceId: productionAuthorization.evidenceId,
      releaseCommitSha: productionAuthorization.releaseCommitSha,
      deploymentManifestHash: productionAuthorization.deploymentManifestHash,
      [field]: value,
    })))));

    await expect(gateway({
      TREASURY_BANK_SUBMISSION_MODE: 'production',
    }).submit({
      ...input,
      productionAuthorization,
    })).rejects.toThrow('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
  });

  it('网络异常收敛为稳定错误且不保留上游 cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('private-bank-host bearer-secret'),
    ));

    const error = await gateway().submit(input).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('TREASURY_BANK_SUBMISSION_UNAVAILABLE'));
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('private-bank-host');
  });

  it.each([400, 409, 429, 503])('非 2xx %s 只按状态码分类且不读取正文', async (status) => {
    const body = {
      getReader: vi.fn(() => {
        throw new Error('不得读取银行错误正文');
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body,
    }));

    await expect(gateway().submit(input)).rejects.toThrow(
      `TREASURY_BANK_SUBMISSION_HTTP_${status}`,
    );
    expect(body.getReader).not.toHaveBeenCalled();
  });

  it.each([
    'text/plain',
    'application/json-unsafe',
    'application/json; charset=gbk',
    'application/json; profile=unsafe',
  ])('拒绝非严格 JSON Content-Type %s', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(receipt()),
      { 'content-type': contentType },
    )));

    await expect(gateway().submit(input)).rejects.toThrow(
      'TREASURY_BANK_SUBMISSION_RECEIPT_INVALID',
    );
  });

  it.each([
    'application/json',
    'APPLICATION/JSON; CHARSET=UTF-8',
    'application/problem+json;charset=utf-8',
  ])('接受规范 JSON Content-Type %s', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(receipt()),
      { 'content-type': contentType },
    )));

    await expect(gateway().submit(input)).resolves.toMatchObject({
      submissionId: 'bank-submission-001',
    });
  });

  it.each([
    ['invalid', 'TREASURY_BANK_SUBMISSION_RESPONSE_LENGTH_INVALID'],
    ['-1', 'TREASURY_BANK_SUBMISSION_RESPONSE_LENGTH_INVALID'],
    ['01', 'TREASURY_BANK_SUBMISSION_RESPONSE_LENGTH_INVALID'],
    [String(RESPONSE_LIMIT_BYTES + 1), 'TREASURY_BANK_SUBMISSION_RESPONSE_TOO_LARGE'],
    ['9'.repeat(30), 'TREASURY_BANK_SUBMISSION_RESPONSE_TOO_LARGE'],
  ])('拒绝非法或超大 Content-Length %s', async (contentLength, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(receipt()),
      {
        'content-type': 'application/json',
        'content-length': contentLength,
      },
    )));

    await expect(gateway().submit(input)).rejects.toThrow(code);
  });

  it('拒绝无正文的成功响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    }));

    await expect(gateway().submit(input)).rejects.toThrow(
      'TREASURY_BANK_SUBMISSION_RECEIPT_INVALID',
    );
  });

  it('无 Content-Length 的超大流式响应仍取消读取并失败关闭', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(RESPONSE_LIMIT_BYTES + 1),
      }),
      cancel,
      releaseLock,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    }));

    await expect(gateway().submit(input)).rejects.toThrow(
      'TREASURY_BANK_SUBMISSION_RESPONSE_TOO_LARGE',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each([
    ['读取失败', vi.fn().mockRejectedValue(new Error('secret upstream detail'))],
    ['非法分块', vi.fn().mockResolvedValue({ done: false, value: 'not-bytes' })],
  ])('%s 时取消读取并返回稳定错误', async (_name, read) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));

    const error = await gateway().submit(input).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('TREASURY_BANK_SUBMISSION_RESPONSE_READ_ERROR'));
    expect(error).not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('取消和释放读取器异常不得覆盖本域结果', async () => {
    const validBytes = new TextEncoder().encode(JSON.stringify(receipt()));
    const readers = [
      {
        read: vi.fn().mockRejectedValue(new Error('read failed')),
        cancel: vi.fn(() => {
          throw new Error('cancel failed');
        }),
        releaseLock: vi.fn(),
      },
      {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: validBytes })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn(),
        releaseLock: vi.fn(() => {
          throw new Error('release failed');
        }),
      },
    ];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => readers[0] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => readers[1] },
      }));

    await expect(gateway().submit(input)).rejects.toThrow(
      'TREASURY_BANK_SUBMISSION_RESPONSE_READ_ERROR',
    );
    await expect(gateway().submit(input)).resolves.toMatchObject({
      submissionId: 'bank-submission-001',
    });
  });

  it('拒绝非严格 UTF-8、非法 JSON、标量和未知回执字段', async () => {
    const invalidUtf8Reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([0xc3, 0x28]) })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => invalidUtf8Reader },
      })
      .mockResolvedValueOnce(okResponse('{invalid'))
      .mockResolvedValueOnce(okResponse('[]'))
      .mockResolvedValueOnce(okResponse(JSON.stringify(receipt({ extra: true })))));

    for (let index = 0; index < 4; index += 1) {
      await expect(gateway().submit(input)).rejects.toThrow(
        'TREASURY_BANK_SUBMISSION_RECEIPT_INVALID',
      );
    }
  });

  it.each([
    ['batchId', 'another-batch'],
    ['objectRef', 'worm/treasury/another-object'],
    ['fileHash', 'b'.repeat(43)],
    ['lineCount', input.lineCount + 1],
    ['totalMinor', input.totalMinor + 1],
    ['submissionMode', 'production'],
    ['accepted', false],
  ])('拒绝未绑定当前批次控制量的回执 %s', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(receipt({ [field]: value })),
    )));

    await expect(gateway().submit(input)).rejects.toThrow(
      'TREASURY_BANK_SUBMISSION_RECEIPT_INVALID',
    );
  });
});
