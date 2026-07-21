import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpPayrollTaxImmutableArchive } from './payroll-tax-archive-http.adapter.js';

const FILING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const BYTES = Buffer.from(
  `{"schema":"CN_IIT_WITHHOLDING_MANIFEST_V1","filingId":"${FILING_ID}","lines":[]}`,
  'utf8',
);
const HASH = createHash('sha256').update(BYTES).digest('base64url');
const OBJECT_KEY = `payroll-tax/${FILING_ID}/${HASH}.json`;

function config(overrides?: Readonly<Record<string, string | number>>) {
  const values: Readonly<Record<string, string | number>> = {
    PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'https://tax-worm.example.internal/v1/objects',
    PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: 'tax-worm-token-at-least-32-characters',
    PAYROLL_TAX_WORM_RETENTION_DAYS: 3_650,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function input() {
  return {
    tenantId: 'tenant-001', filingId: FILING_ID,
    objectKey: OBJECT_KEY, sha256: HASH, bytes: BYTES,
  };
}

function receipt(changes?: Readonly<Record<string, unknown>>) {
  return {
    objectRef: 'worm/payroll-tax/locked-object-001', evidenceId: 'tax-worm-evidence-001',
    immutable: true, sha256: HASH, objectKey: OBJECT_KEY, retentionDays: 3_650,
    ...changes,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Payroll Tax WORM HTTPS Adapter', () => {
  it('只通过请求体发送清单并严格绑定不可变回执与十年保留期', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt()), {
      status: 201, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(input())).resolves.toEqual({
      objectRef: 'worm/payroll-tax/locked-object-001',
      evidenceId: 'tax-worm-evidence-001', immutable: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://tax-worm.example.internal/v1/objects');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error', body: BYTES });
    expect(headers).toMatchObject({
      'x-object-key': OBJECT_KEY, 'x-content-sha256': HASH,
      'x-data-classification': 'L4', 'x-retention-policy': 'payroll_tax_filing',
      'x-retention-days': '3650',
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(headers)).not.toContain('CN_IIT_WITHHOLDING_MANIFEST_V1');
  });

  it('拒绝错摘要、可变回执、保留期不足与超大响应', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpPayrollTaxImmutableArchive(config()).put({
      ...input(), sha256: 'A'.repeat(43),
    })).rejects.toThrow('PAYROLL_TAX_ARCHIVE_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
    for (const invalid of [
      receipt({ sha256: 'B'.repeat(43) }), receipt({ immutable: false }),
      receipt({ retentionDays: 3_649 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
      await expect(new HttpPayrollTaxImmutableArchive(config()).put(input()))
        .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(20_000), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(input()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE');
  });

  it('未配置、非法端点或上游失败时失败关闭', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpPayrollTaxImmutableArchive(empty).put(input()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
    await expect(new HttpPayrollTaxImmutableArchive(config({
      PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: 'https://tax-worm.example/v1/objects?token=unsafe',
    })).put(input())).rejects.toThrow('PAYROLL_TAX_ENDPOINT_INVALID');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new HttpPayrollTaxImmutableArchive(config()).put(input()))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_HTTP_503');
  });
});
