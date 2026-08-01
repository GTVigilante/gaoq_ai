import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryBankReturnInbox } from './treasury-bank-return-http.adapter.js';

const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const ENDPOINT = 'https://return-inbox.example.internal/v1/returns/claim';
const TOKEN = 'return-inbox-token-at-least-32-characters';
const claim = Object.freeze({
  tenantId: 'tenant-001',
  batchId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  bankSubmissionId: 'bank-submission-001',
});
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R2';
const returnLine = Object.freeze({
  instructionId: 'instruction-001',
  outcome: 'succeeded' as const,
  amountMinor: 839_500,
  bankLineReference: 'bank-line-001',
});

function config(
  overrides: Readonly<Record<string, string | undefined>> = {},
): ConfigService<AppEnvironment, true> {
  const values: Readonly<Record<string, string | undefined>> = {
    TREASURY_BANK_RETURN_INBOX_ENDPOINT: ENDPOINT,
    TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: TOKEN,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as
    ConfigService<AppEnvironment, true>;
}

function inbox(
  overrides: Readonly<Record<string, string | undefined>> = {},
): HttpTreasuryBankReturnInbox {
  return new HttpTreasuryBankReturnInbox(config(overrides));
}

function manifest(changes: Readonly<Record<string, unknown>> = {}) {
  return {
    returnId: RETURN_ID,
    ...claim,
    sequence: 1,
    returnHash: 'r'.repeat(43),
    objectRef: 'worm/treasury/returns/return-001',
    objectEvidenceId: 'return-object-001',
    signatureEvidenceId: 'signature-001',
    signatureVerified: true,
    malwareScanEvidenceId: 'scan-001',
    malwareClean: true,
    receivedAt: '2026-07-22T03:00:00.000Z',
    lines: [returnLine],
    ...changes,
  };
}

function okResponse(
  body: string = JSON.stringify(manifest()),
  headers: Readonly<Record<string, string>> = {
    'content-type': 'application/json; charset=utf-8',
  },
): Response {
  return new Response(body, { status: 200, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury 回盘 Inbox HTTPS Adapter', () => {
  it('只从固定 HTTPS 路径领取严格限流清单与防护证据', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await inbox().claim(claim);

    expect(result).toMatchObject({
      ...claim,
      returnId: RETURN_ID,
      signatureVerified: true,
      malwareClean: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lines)).toBe(true);
    expect(Object.isFrozen(result.lines[0])).toBe(true);
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
    expect(JSON.parse(call[1].body)).toEqual(claim);
    expect(call[1].body).not.toMatch(/file|account|employee|amount/u);
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

  it('相同领取对象生成相同幂等键，提交回执变化后生成不同键', async () => {
    const changedClaim = { ...claim, bankSubmissionId: 'bank-submission-002' };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse(JSON.stringify(manifest(changedClaim))));
    vi.stubGlobal('fetch', fetchMock);

    await inbox().claim(claim);
    await inbox().claim(claim);
    await inbox().claim(changedClaim);

    const keys = fetchMock.mock.calls.map((call) =>
      (call[1]?.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    ['tenantId', ''],
    ['tenantId', '../tenant'],
    ['batchId', 'batch-001'],
    ['batchId', '01J8ZQK7V0A2M4N6P8R0T2W4I1'],
    ['bankSubmissionId', ' invalid'],
  ])('拒绝非法领取输入 %s', async (field, value) => {
    await expect(inbox().claim({
      ...claim,
      [field]: value,
    })).rejects.toThrow('TREASURY_BANK_RETURN_CLAIM_INVALID');
  });

  it('端点或凭据缺失时失败关闭', async () => {
    await expect(inbox({
      TREASURY_BANK_RETURN_INBOX_ENDPOINT: undefined,
    }).claim(claim)).rejects.toThrow('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
    await expect(inbox({
      TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: undefined,
    }).claim(claim)).rejects.toThrow('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
  });

  it.each([
    '',
    'short',
    'x'.repeat(513),
    `valid-prefix\n${'x'.repeat(32)}`,
  ])('拒绝非法回盘 Inbox 凭据', async (token) => {
    await expect(inbox({
      TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: token,
    }).claim(claim)).rejects.toThrow('TREASURY_BANK_RETURN_CREDENTIAL_INVALID');
  });

  it.each([
    'invalid',
    'http://inbox.example/v1/returns/claim',
    'https://user@inbox.example/v1/returns/claim',
    'https://user:password@inbox.example/v1/returns/claim',
    'https://inbox.example:8443/v1/returns/claim',
    'https://inbox.example/v1/returns/claim?token=unsafe',
    'https://inbox.example/v1/returns/claim#fragment',
    'https://inbox.example/v1/returns',
    'https://inbox.example/v1/returns/claim/',
  ])('拒绝非固定标准 HTTPS 回盘端点 %s', async (endpoint) => {
    await expect(inbox({
      TREASURY_BANK_RETURN_INBOX_ENDPOINT: endpoint,
    }).claim(claim)).rejects.toThrow('TREASURY_BANK_RETURN_ENDPOINT_INVALID');
  });

  it('网络异常收敛为稳定错误且不保留上游 cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('private-inbox-host bearer-secret'),
    ));

    const error = await inbox().claim(claim).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE'));
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('private-inbox-host');
  });

  it.each([400, 409, 429, 503])('非 2xx %s 只按状态码分类且不读取正文', async (status) => {
    const body = {
      getReader: vi.fn(() => {
        throw new Error('不得读取回盘错误正文');
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body,
    }));

    await expect(inbox().claim(claim)).rejects.toThrow(
      `TREASURY_BANK_RETURN_INBOX_HTTP_${status}`,
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
      JSON.stringify(manifest()),
      { 'content-type': contentType },
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
    );
  });

  it.each([
    'application/json',
    'APPLICATION/JSON; CHARSET=UTF-8',
    'application/problem+json;charset=utf-8',
  ])('接受规范 JSON Content-Type %s', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest()),
      { 'content-type': contentType },
    )));

    await expect(inbox().claim(claim)).resolves.toMatchObject({
      returnId: RETURN_ID,
    });
  });

  it.each([
    ['invalid', 'TREASURY_BANK_RETURN_RESPONSE_LENGTH_INVALID'],
    ['-1', 'TREASURY_BANK_RETURN_RESPONSE_LENGTH_INVALID'],
    ['01', 'TREASURY_BANK_RETURN_RESPONSE_LENGTH_INVALID'],
    [String(RESPONSE_LIMIT_BYTES + 1), 'TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE'],
    ['9'.repeat(30), 'TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE'],
  ])('拒绝非法或超大 Content-Length %s', async (contentLength, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest()),
      {
        'content-type': 'application/json',
        'content-length': contentLength,
      },
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(code);
  });

  it('接受与正文匹配的规范 Content-Length', async () => {
    const body = JSON.stringify(manifest());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })));

    await expect(inbox().claim(claim)).resolves.toMatchObject({
      returnId: RETURN_ID,
    });
  });

  it('拒绝无正文的成功响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    }));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
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
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    }));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE',
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
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));

    const error = await inbox().claim(claim).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('TREASURY_BANK_RETURN_RESPONSE_READ_ERROR'));
    expect(error).not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('无法取得读取器时返回稳定读取错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => {
          throw new Error('locked stream with secret detail');
        },
      },
    }));

    const error = await inbox().claim(claim).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('TREASURY_BANK_RETURN_RESPONSE_READ_ERROR'));
    expect(String(error)).not.toContain('secret detail');
  });

  it('取消和释放读取器异常不得覆盖本域结果', async () => {
    const validBytes = new TextEncoder().encode(JSON.stringify(manifest()));
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
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => readers[0] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => readers[1] },
      }));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_RESPONSE_READ_ERROR',
    );
    await expect(inbox().claim(claim)).resolves.toMatchObject({
      returnId: RETURN_ID,
    });
  });

  it('拒绝非严格 UTF-8、非法 JSON、标量和未知清单字段', async () => {
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
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => invalidUtf8Reader },
      })
      .mockResolvedValueOnce(okResponse('{invalid'))
      .mockResolvedValueOnce(okResponse('[]'))
      .mockResolvedValueOnce(okResponse(JSON.stringify(manifest({ rawFile: 'forbidden' })))));

    for (let index = 0; index < 4; index += 1) {
      await expect(inbox().claim(claim)).rejects.toThrow(
        'TREASURY_BANK_RETURN_MANIFEST_INVALID',
      );
    }
  });

  it.each([
    ['tenantId', 'tenant-other'],
    ['batchId', '01J8ZQK7V0A2M4N6P8R0T2W4F2'],
    ['bankSubmissionId', 'bank-submission-other'],
  ])('拒绝未绑定当前领取对象的清单字段 %s', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest({ [field]: value })),
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
    );
  });

  it.each([
    ['signatureEvidenceId', 'return-object-001'],
    ['malwareScanEvidenceId', 'signature-001'],
  ])('拒绝复用独立防护证据 ID：%s', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest({ [field]: value })),
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
    );
  });

  it.each([
    ['returnId', 'return-001'],
    ['sequence', 0],
    ['returnHash', 'short'],
    ['objectRef', '../secret'],
    ['objectEvidenceId', ' invalid'],
    ['signatureEvidenceId', ' invalid'],
    ['malwareScanEvidenceId', ' invalid'],
    ['receivedAt', '2026-07-22T03:00:00'],
    ['lines', [{ ...returnLine, outcome: 'unknown' }]],
    ['lines', [{ ...returnLine, amountMinor: 0 }]],
    ['lines', [{ ...returnLine, bankLineReference: ' invalid' }]],
  ])('拒绝非法清单字段 %s', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest({ [field]: value })),
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
    );
  });

  it('拒绝超过 5,000 行的规范化清单', async () => {
    const lines = Array.from({ length: 5_001 }, (_, index) => ({
      ...returnLine,
      instructionId: `instruction-${index}`,
      bankLineReference: `bank-line-${index}`,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest({ lines })),
    )));

    await expect(inbox().claim(claim)).rejects.toThrow(
      'TREASURY_BANK_RETURN_MANIFEST_INVALID',
    );
  });

  it.each([
    ['signatureVerified', false],
    ['malwareClean', false],
  ])('保留 %s=false 供应用服务执行整批冻结', async (field, value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(
      JSON.stringify(manifest({ [field]: value })),
    )));

    await expect(inbox().claim(claim)).resolves.toMatchObject({
      [field]: false,
    });
  });
});
