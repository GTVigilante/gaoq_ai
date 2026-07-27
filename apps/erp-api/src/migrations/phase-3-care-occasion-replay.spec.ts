import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { replayCareOccasionTask } from './phase-3-care-occasion-replay.js';

describe('Phase 3 关怀周年受控重放', () => {
  it('dry-run 只校验 dead 状态和版本，不写任务或 Outbox', async () => {
    const fixture = connectionFixture();
    const result = await replayCareOccasionTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'care-task-001',
      expectedVersion: 4,
      reasonCode: 'GATEWAY_RECOVERED',
    }, 'dry-run');
    expect(result).toMatchObject({
      previousVersion: 4,
      version: 5,
      status: 'pending',
      applied: false,
    });
    expect(fixture.updateOne).not.toHaveBeenCalled();
    expect(fixture.insertOne).not.toHaveBeenCalled();
  });

  it('apply 以版本条件恢复 pending，并同事务追加脱敏 replayed 事件', async () => {
    const fixture = connectionFixture();
    const result = await replayCareOccasionTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'care-task-001',
      expectedVersion: 4,
      reasonCode: 'GATEWAY_RECOVERED',
    }, 'apply');
    expect(result.applied).toBe(true);
    const updateCall = JSON.stringify(fixture.updateOne.mock.calls);
    expect(updateCall).toContain('"tenantId":"tenant-001"');
    expect(updateCall).toContain('"id":"care-task-001"');
    expect(updateCall).toContain('"status":"pending"');
    expect(updateCall).toContain('"attempts":0');
    expect(updateCall).toContain('"version":1');
    const insertCall = JSON.stringify(fixture.insertOne.mock.calls);
    expect(insertCall).toContain('"aggregateId":"care-task-001"');
    expect(insertCall).toContain('"aggregateVersion":5');
    expect(insertCall).toContain('"eventType":"cn.gaoq.erp.care.occasion.replayed.v1"');
    expect(insertCall).toContain('"reasonCode":"GATEWAY_RECOVERED"');
    expect(insertCall).not.toMatch(
      /birthdayMonthDay|employeeId|contact|body|deliveryEvidence/iu,
    );
  });

  it('拒绝自由文本原因和非 dead/版本冲突', async () => {
    const fixture = connectionFixture();
    await expect(replayCareOccasionTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'care-task-001',
      expectedVersion: 4,
      reasonCode: '用户说可以重试',
    }, 'dry-run')).rejects.toThrow('CARE_OCCASION_REPLAY_INPUT_INVALID');
    fixture.findOne.mockResolvedValueOnce(null);
    await expect(replayCareOccasionTask(fixture.connection, {
      tenantId: 'tenant-001',
      taskId: 'care-task-001',
      expectedVersion: 4,
      reasonCode: 'GATEWAY_RECOVERED',
    }, 'apply')).rejects.toThrow('CARE_OCCASION_REPLAY_STATE_CONFLICT');
  });
});

function connectionFixture() {
  const findOne = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001',
    id: 'care-task-001',
    status: 'dead',
    version: 4,
    occasionType: 'birthday',
    policyVersion: 'care-v1',
  });
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
    collection: vi.fn((name: string) => name === 'care_occasion_tasks'
      ? { findOne, updateOne }
      : { insertOne }),
  } as unknown as Connection;
  return { connection, findOne, updateOne, insertOne, session };
}
