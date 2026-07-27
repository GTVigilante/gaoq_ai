import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { rebuildCareAlumniCleanupSourceEvents } from './phase-3-care-alumni-cleanup-rebuild.js';

const targets = [{ targetCode: 'crm', policyVersion: 'privacy-v1' }];

describe('Phase 3 校友清理源事件重建', () => {
  it('dry-run 只统计终态授权的缺失目标覆盖', async () => {
    const fixture = connectionFixture();
    const result = await rebuildCareAlumniCleanupSourceEvents(
      fixture.connection,
      'dry-run',
      targets,
    );
    expect(result).toMatchObject({
      checkedTerminalConsents: 1,
      missingCoverage: 1,
      recreatedEvents: 0,
      applied: false,
    });
    expect(fixture.insertOne).not.toHaveBeenCalled();
  });

  it('apply 重建原始 withdrawn Outbox，且不复制自然人与证据', async () => {
    const fixture = connectionFixture();
    const result = await rebuildCareAlumniCleanupSourceEvents(
      fixture.connection,
      'apply',
      targets,
    );
    expect(result).toMatchObject({ recreatedEvents: 1, applied: true });
    const inserted = JSON.stringify(fixture.insertOne.mock.calls);
    expect(inserted).toContain(
      'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
    );
    expect(inserted).not.toMatch(
      /personId|consentEvidenceId|phone|emailAddress|proofDigest/iu,
    );
  });

  it('没有登记目标时失败关闭', async () => {
    await expect(rebuildCareAlumniCleanupSourceEvents(
      connectionFixture().connection,
      'dry-run',
      [],
    )).rejects.toThrow('CARE_ALUMNI_CLEANUP_REBUILD_TARGETS_REQUIRED');
  });
});

function connectionFixture() {
  const consent = {
    tenantId: 'tenant-001',
    id: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
    careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
    purpose: 'alumni_network',
    channels: ['email'],
    expiresAt: new Date('2027-07-27T00:00:00.000Z'),
    withdrawnAt: new Date('2026-07-27T00:00:00.000Z'),
    expiredAt: null,
    status: 'withdrawn',
    version: 2,
  };
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const collections = {
    care_alumni_consents: {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([consent]),
        }),
      }),
    },
    care_alumni_cleanup_tasks: {
      countDocuments: vi.fn().mockResolvedValue(0),
    },
    integration_outbox: {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne,
      updateOne,
    },
  };
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
    collection: vi.fn((name: keyof typeof collections) => collections[name]),
  } as unknown as Connection;
  return { connection, insertOne, updateOne };
}
