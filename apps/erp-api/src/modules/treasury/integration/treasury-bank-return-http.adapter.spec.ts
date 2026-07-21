import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryBankReturnInbox } from './treasury-bank-return-http.adapter.js';

const claim = Object.freeze({
  tenantId: 'tenant-001', batchId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  bankSubmissionId: 'bank-submission-001',
});
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R2';

function config(overrides?: Readonly<Record<string, string>>) {
  const values: Readonly<Record<string, string>> = {
    TREASURY_BANK_RETURN_INBOX_ENDPOINT: 'https://return-inbox.example.internal/v1/returns/claim',
    TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: 'return-inbox-token-at-least-32-characters',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function manifest(changes?: Readonly<Record<string, unknown>>) {
  return {
    returnId: RETURN_ID, ...claim, sequence: 1, returnHash: 'r'.repeat(43),
    objectRef: 'worm/treasury/returns/return-001', objectEvidenceId: 'return-object-001',
    signatureEvidenceId: 'signature-001', signatureVerified: true,
    malwareScanEvidenceId: 'scan-001', malwareClean: true,
    receivedAt: '2026-07-22T03:00:00.000Z', lines: [{
      instructionId: 'instruction-001', outcome: 'succeeded',
      amountMinor: 839_500, bankLineReference: 'bank-line-001',
    }], ...changes,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury 回盘 Inbox HTTPS Adapter', () => {
  it('只领取严格限流清单，并保留验签、扫描和 WORM 证据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(manifest()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new HttpTreasuryBankReturnInbox(config()).claim(claim);
    expect(result).toMatchObject({
      batchId: claim.batchId, bankSubmissionId: claim.bankSubmissionId,
      signatureVerified: true, malwareClean: true,
    });
    expect(Object.isFrozen(result.lines)).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    if (typeof call[1].body !== 'string') throw new Error('测试请求体必须为 JSON 字符串');
    expect(JSON.parse(call[1].body)).toEqual(claim);
    expect(call[1].body).not.toMatch(/file|account|employee/u);
  });

  it('拒绝错批次、错提交、原始正文和超大清单', async () => {
    for (const invalid of [
      manifest({ batchId: 'other-batch' }), manifest({ bankSubmissionId: 'other-submission' }),
      manifest({ returnId: 'return-001' }),
      { ...manifest(), rawFile: 'forbidden' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
      await expect(new HttpTreasuryBankReturnInbox(config()).claim(claim))
        .rejects.toThrow('TREASURY_BANK_RETURN_MANIFEST_INVALID');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(new HttpTreasuryBankReturnInbox(config()).claim(claim))
      .rejects.toThrow('TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE');
  });

  it('未配置、非法端点和上游失败时失败关闭', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpTreasuryBankReturnInbox(empty).claim(claim))
      .rejects.toThrow('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
    await expect(new HttpTreasuryBankReturnInbox(config({
      TREASURY_BANK_RETURN_INBOX_ENDPOINT: 'https://inbox.example/v1/returns?token=unsafe',
    })).claim(claim)).rejects.toThrow('TREASURY_BANK_RETURN_ENDPOINT_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new HttpTreasuryBankReturnInbox(config()).claim(claim))
      .rejects.toThrow('TREASURY_BANK_RETURN_INBOX_HTTP_503');
  });
});
