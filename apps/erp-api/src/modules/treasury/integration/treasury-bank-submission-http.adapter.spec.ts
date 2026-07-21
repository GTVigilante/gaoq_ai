import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryBankSubmissionGateway } from './treasury-bank-submission-http.adapter.js';

const input = Object.freeze({
  tenantId: 'tenant-001', batchId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  objectRef: 'worm/treasury/locked-object-001', fileHash: 'a'.repeat(43),
  lineCount: 2, totalMinor: 1_839_600,
});

function config(overrides?: Readonly<Record<string, string>>) {
  const values: Readonly<Record<string, string>> = {
    TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank-gateway.example.internal/v1/submissions',
    TREASURY_BANK_SUBMISSION_BEARER_TOKEN: 'bank-gateway-token-at-least-32-characters',
    TREASURY_BANK_SUBMISSION_MODE: 'sandbox',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  return {
    submissionId: 'bank-submission-001', evidenceId: 'bank-evidence-001', accepted: true,
    batchId: input.batchId, objectRef: input.objectRef, fileHash: input.fileHash,
    lineCount: input.lineCount, totalMinor: input.totalMinor, submissionMode: 'sandbox',
    ...changes,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury 银行提交 HTTPS Adapter', () => {
  it('只提交 WORM 引用与控制量，并严格绑定受理回执', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt()), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpTreasuryBankSubmissionGateway(config()).submit(input)).resolves.toEqual({
      submissionId: 'bank-submission-001', evidenceId: 'bank-evidence-001', accepted: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须是 JSON 字符串');
    expect(call[0]).toBe('https://bank-gateway.example.internal/v1/submissions');
    expect(JSON.parse(call[1].body)).toEqual({ ...input, submissionMode: 'sandbox' });
    expect(call[1].body).not.toMatch(/creditor|debtor|account|xml/u);
    expect((call[1].headers as Record<string, string>)['idempotency-key'])
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('拒绝错批次、错摘要、未受理或超大回执', async () => {
    for (const invalid of [
      receipt({ batchId: 'another-batch' }), receipt({ fileHash: 'b'.repeat(43) }),
      receipt({ accepted: false }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
      await expect(new HttpTreasuryBankSubmissionGateway(config()).submit(input))
        .rejects.toThrow('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(20_000), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(new HttpTreasuryBankSubmissionGateway(config()).submit(input))
      .rejects.toThrow('TREASURY_BANK_SUBMISSION_RESPONSE_TOO_LARGE');
  });

  it('未配置、非法端点或上游失败时失败关闭', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpTreasuryBankSubmissionGateway(empty).submit(input))
      .rejects.toThrow('TREASURY_BANK_SUBMISSION_UNAVAILABLE');
    await expect(new HttpTreasuryBankSubmissionGateway(config({
      TREASURY_BANK_SUBMISSION_ENDPOINT: 'https://bank.example/v1/submissions?token=unsafe',
    })).submit(input)).rejects.toThrow('TREASURY_BANK_SUBMISSION_ENDPOINT_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new HttpTreasuryBankSubmissionGateway(config()).submit(input))
      .rejects.toThrow('TREASURY_BANK_SUBMISSION_HTTP_503');
  });

  it('Adapter 防御性拒绝 production，且要求上游回执回显 sandbox', async () => {
    await expect(new HttpTreasuryBankSubmissionGateway(config({
      TREASURY_BANK_SUBMISSION_MODE: 'production',
    })).submit(input)).rejects.toThrow('TREASURY_BANK_PRODUCTION_SUBMISSION_NOT_AUTHORIZED');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt({
      submissionMode: 'production',
    })), { status: 202, headers: { 'content-type': 'application/json' } })));
    await expect(new HttpTreasuryBankSubmissionGateway(config()).submit(input))
      .rejects.toThrow('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
  });
});
