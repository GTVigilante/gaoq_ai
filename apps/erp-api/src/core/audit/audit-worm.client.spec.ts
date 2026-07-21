import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { HttpAuditWormClient, type AuditWormWriteRequest } from './audit-worm.client.js';

const payloadHash = 'a'.repeat(43);
const request: AuditWormWriteRequest = {
  payloadCanonical: '{}', payloadHash, signingKeyId: 'anchor-key-001',
  signature: 'signature', retainUntil: '2033-07-19T00:00:00.000Z',
};

function client() {
  const values: Readonly<Record<string, string>> = {
    AUDIT_WORM_ENDPOINT: 'https://worm.example.internal/anchors',
    AUDIT_WORM_BEARER_TOKEN: 'worm-token-that-is-at-least-32-characters',
  };
  return new HttpAuditWormClient({
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>);
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpAuditWormClient', () => {
  it('使用幂等键写入且严格校验 WORM 回执', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      receiptId: 'receipt-001', objectVersion: 'locked-v1', payloadHash,
      retainedUntil: '2033-07-20T00:00:00.000Z', anchoredAt: '2026-07-21T06:00:00.000Z',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client().write(request)).resolves.toMatchObject({ receiptId: 'receipt-001' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://worm.example.internal/anchors');
    expect(call[1].method).toBe('POST');
    expect(call[1].redirect).toBe('error');
    expect(call[1].headers).toEqual(expect.objectContaining({ 'idempotency-key': payloadHash }));
  });

  it('拒绝哈希不一致或保留期不足的回执', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      receiptId: 'receipt-001', objectVersion: 'locked-v1', payloadHash: 'b'.repeat(43),
      retainedUntil: '2033-07-20T00:00:00.000Z', anchoredAt: '2026-07-21T06:00:00.000Z',
    }), { status: 200 })));
    await expect(client().write(request)).rejects.toThrow('AUDIT_WORM_RECEIPT_INVALID');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      receiptId: 'receipt-001', objectVersion: 'locked-v1', payloadHash,
      retainedUntil: '2030-01-01T00:00:00.000Z', anchoredAt: '2026-07-21T06:00:00.000Z',
    }), { status: 200 })));
    await expect(client().write(request)).rejects.toThrow('AUDIT_WORM_RETENTION_INSUFFICIENT');
  });
});
