import { describe, expect, it, vi } from 'vitest';

import { synchronizeMasterData } from './master-data-sync.js';

const config = {
  tokenUrl: 'https://erp.example.com/oauth/token',
  clientId: 'payroll-sync',
  clientSecret: 'test-only-secret',
  erpResource: 'https://erp.example.com/api',
  payrollResource: 'https://payroll.example.com/api',
  erpApiUrl: 'https://erp.example.com',
  payrollApiUrl: 'https://payroll.example.com',
};

describe('ERP 主数据快照同步', () => {
  it('使用双资源令牌传输所有快照页', async () => {
    const digest = 'a'.repeat(64);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(token('erp-access-token-value-0001'))
      .mockResolvedValueOnce(token('payroll-access-token-0001'))
      .mockResolvedValueOnce(page(digest, 'next-page'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(page(digest, null))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(synchronizeMasterData(config, fetcher))
      .resolves.toEqual({ snapshotId: digest, pageCount: 2 });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(String(fetcher.mock.calls[4]?.[0])).toContain('cursor=next-page');
    const payrollRequest = fetcher.mock.calls[3]?.[1] as RequestInit | undefined;
    expect(payrollRequest?.headers).toMatchObject({
      authorization: 'Bearer payroll-access-token-0001',
    });
  });

  it('拒绝跨页快照标识变化', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(token('erp-access-token-value-0001'))
      .mockResolvedValueOnce(token('payroll-access-token-0001'))
      .mockResolvedValueOnce(page('a'.repeat(64), 'next-page'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(page('b'.repeat(64), null));

    await expect(synchronizeMasterData(config, fetcher))
      .rejects.toThrow('快照标识不一致');
  });
});

const token = (accessToken: string): Response =>
  new Response(JSON.stringify({
    access_token: accessToken,
    token_type: 'Bearer',
  }), { status: 200 });

const page = (digest: string, nextCursor: string | null): Response =>
  new Response(JSON.stringify({
    snapshotId: digest,
    snapshotDigest: digest,
    nextCursor,
  }), { status: 200 });
