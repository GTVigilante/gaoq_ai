import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { replayCareAlumniCleanupTask } from './phase-3-care-alumni-cleanup-replay.js';

const targets = [{ targetCode: 'crm', policyVersion: 'privacy-v1' }];

describe('Phase 3 校友下游清理受控重放', () => {
  it('dry-run 只校验 dead、版本、空证明和当前目标策略', async () => {
    const fixture = connectionFixture();
    const result = await replayCareAlumniCleanupTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'A'.repeat(43),
      expectedVersion: 4,
      reasonCode: 'CHANNEL_OWNER_APPROVED',
    }, 'dry-run', targets);
    expect(result).toMatchObject({
      previousVersion: 4,
      version: 5,
      status: 'pending',
      applied: false,
    });
    expect(fixture.updateOne).not.toHaveBeenCalled();
    expect(fixture.insertOne).not.toHaveBeenCalled();
  });

  it('apply 以版本条件恢复并同事务追加脱敏 replayed 事件', async () => {
    const fixture = connectionFixture();
    await replayCareAlumniCleanupTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'A'.repeat(43),
      expectedVersion: 4,
      reasonCode: 'CHANNEL_OWNER_APPROVED',
    }, 'apply', targets);
    const update = JSON.stringify(fixture.updateOne.mock.calls);
    expect(update).toContain('"status":"pending"');
    expect(update).toContain('"attempts":0');
    const inserted = JSON.stringify(fixture.insertOne.mock.calls);
    expect(inserted).toContain('cn.gaoq.erp.care.alumni_cleanup.replayed.v1');
    expect(inserted).toContain('CHANNEL_OWNER_APPROVED');
    expect(inserted).not.toMatch(
      /personId|contactAddress|phone|emailAddress|proofDigest|consentEvidence/iu,
    );
  });

  it('拒绝自由文本、非 dead 状态和登记策略漂移', async () => {
    const fixture = connectionFixture();
    await expect(replayCareAlumniCleanupTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'A'.repeat(43),
      expectedVersion: 4,
      reasonCode: '人工说可以',
    }, 'dry-run', targets)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_REPLAY_INPUT_INVALID',
    );
    await expect(replayCareAlumniCleanupTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'A'.repeat(43),
      expectedVersion: 4,
      reasonCode: 'CHANNEL_OWNER_APPROVED',
    }, 'dry-run', [])).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_REPLAY_TARGET_DRIFT',
    );
  });
});

function connectionFixture() {
  const findOne = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001',
    id: 'A'.repeat(43),
    status: 'dead',
    version: 4,
    targetCode: 'crm',
    policyVersion: 'privacy-v1',
    consentPurpose: 'alumni_network',
    proofDigest: null,
  });
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
    collection: vi.fn((name: string) =>
      name === 'care_alumni_cleanup_tasks'
        ? { findOne, updateOne }
        : { insertOne }),
  } as unknown as Connection;
  return { connection, findOne, updateOne, insertOne };
}
