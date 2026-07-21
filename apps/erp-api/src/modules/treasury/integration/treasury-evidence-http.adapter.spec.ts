import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { HttpTreasuryImmutableArchive } from './treasury-evidence-http.adapter.js';

const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const XML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Document><CtrlSum>100.00</CtrlSum></Document>',
);
const SHA256 = createHash('sha256').update(XML).digest('base64url');
const OBJECT_KEY = `treasury/${BATCH_ID}/${SHA256}.pain001.xml`;

function config(overrides?: Readonly<Record<string, string | number>>) {
  const values: Readonly<Record<string, string | number>> = {
    TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://treasury-worm.example.internal/v1/objects',
    TREASURY_WORM_ARCHIVE_BEARER_TOKEN: 'treasury-worm-token-at-least-32-characters',
    TREASURY_WORM_RETENTION_DAYS: 3_650,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppEnvironment, true>;
}

function request() {
  return {
    tenantId: 'tenant-001', batchId: BATCH_ID, objectKey: OBJECT_KEY,
    contentType: 'application/xml' as const, classification: 'L4' as const,
    retentionPolicy: 'payroll_disbursement' as const, sha256: SHA256, bytes: XML,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Treasury WORM HTTPS Adapter', () => {
  it('文件只通过 HTTPS 请求体发送，回执绑定摘要、对象键与十年保留期', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      objectRef: 'worm/treasury/locked-object-001', receiptId: 'archive-receipt-001',
      immutable: true, sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 3_650,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpTreasuryImmutableArchive(config()).put(request())).resolves.toEqual({
      objectRef: 'worm/treasury/locked-object-001',
      receiptId: 'archive-receipt-001', immutable: true,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Readonly<Record<string, string>>;
    expect(call[0]).toBe('https://treasury-worm.example.internal/v1/objects');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error', body: XML });
    expect(headers).toMatchObject({
      'x-object-key': OBJECT_KEY, 'x-content-sha256': SHA256,
      'x-data-classification': 'L4', 'x-retention-days': '3650',
    });
    expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(headers['idempotency-key']).not.toContain('tenant-001');
    expect(JSON.stringify(headers)).not.toContain(XML.toString('utf8'));
  });

  it('摘要错位、可变回执或保留期不足时失败关闭', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpTreasuryImmutableArchive(config()).put({
      ...request(), sha256: 'A'.repeat(43),
    })).rejects.toThrow('TREASURY_PAIN001_HASH_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      objectRef: 'worm/treasury/object-001', receiptId: 'receipt-001',
      immutable: true, sha256: SHA256, objectKey: OBJECT_KEY, retentionDays: 365,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(new HttpTreasuryImmutableArchive(config()).put(request()))
      .rejects.toThrow('TREASURY_ARCHIVE_RECEIPT_INVALID');
  });

  it('未配置基础设施或端点包含查询参数时拒绝归档', async () => {
    const empty = { get: () => undefined } as unknown as ConfigService<AppEnvironment, true>;
    await expect(new HttpTreasuryImmutableArchive(empty).put(request()))
      .rejects.toThrow('TREASURY_IMMUTABLE_ARCHIVE_UNAVAILABLE');
    await expect(new HttpTreasuryImmutableArchive(config({
      TREASURY_WORM_ARCHIVE_ENDPOINT: 'https://worm.example.internal/v1/objects?token=unsafe',
    })).put(request())).rejects.toThrow('TREASURY_ARCHIVE_ENDPOINT_INVALID');
  });
});
