import { describe, expect, it, vi } from 'vitest';

import { runCareConsentExpiryJobBackfill } from './phase-3-care-consent-expiry-jobs.js';

function connection(records: readonly Record<string, unknown>[]) {
  const cursor = {
    sort: vi.fn().mockReturnThis(),
    batchSize: vi.fn().mockReturnThis(),
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      for (const record of records) yield record;
    },
  };
  return {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue(cursor),
    }),
  };
}

describe('Phase 3 校友授权到期任务回填', () => {
  it('dry-run 只校验并统计，不写入队列或输出业务标识', async () => {
    const database = connection([
      {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4C4', tenantId: 'tenant-001',
        expiresAt: new Date('2026-07-20T00:00:00.000Z'),
      },
      {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4C5', tenantId: 'tenant-002',
        expiresAt: new Date('2027-07-20T00:00:00.000Z'),
      },
    ]);
    await expect(runCareConsentExpiryJobBackfill(
      database as never, null, Date.parse('2026-07-21T00:00:00.000Z'),
    )).resolves.toEqual({ scanned: 2, due: 1, scheduled: 0 });
  });

  it('apply 使用稳定 JobId 批量重建到期任务', async () => {
    const database = connection([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C4', tenantId: 'tenant-001',
      expiresAt: new Date('2027-07-21T00:00:00.000Z'),
    }]);
    const queue = { addBulk: vi.fn().mockResolvedValue([]) };
    await expect(runCareConsentExpiryJobBackfill(
      database as never, queue as never, Date.parse('2026-07-21T00:00:00.000Z'),
    )).resolves.toEqual({ scanned: 1, due: 0, scheduled: 1 });
    const jobs = queue.addBulk.mock.calls[0]?.[0] as readonly {
      readonly name: string;
      readonly data: unknown;
      readonly opts: { readonly jobId?: string; readonly delay?: number };
    }[] | undefined;
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]).toMatchObject({
      name: 'expire:care:alumni-consent',
      data: {
        tenantId: 'tenant-001',
        consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
      },
      opts: { delay: 365 * 24 * 60 * 60 * 1_000 },
    });
    expect(jobs?.[0]?.opts.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('发现非法历史租户或授权标识时失败关闭', async () => {
    const database = connection([{
      id: 'not-an-ulid', tenantId: 'tenant-001',
      expiresAt: new Date('2027-07-21T00:00:00.000Z'),
    }]);
    await expect(runCareConsentExpiryJobBackfill(
      database as never, null, Date.parse('2026-07-21T00:00:00.000Z'),
    )).rejects.toThrow('CARE_CONSENT_EXPIRY_ID_INVALID');
  });
});
