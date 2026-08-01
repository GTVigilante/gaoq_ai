import { describe, expect, it } from 'vitest';

import type { CareAlumniCleanupTarget } from '../../../config/care-alumni-cleanup-targets.js';
import {
  cleanupIdempotencyKey,
  completeAlumniCleanupTask,
  createAlumniCleanupTask,
  failAlumniCleanupTask,
  replayAlumniCleanupTask,
} from './care-alumni-cleanup.js';

const target: CareAlumniCleanupTarget = {
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'token-not-used-by-domain-test-000000000000',
  policyVersion: 'privacy-v1',
  signingKeyId: 'key-v1',
  signingPublicKeyBase64: 'not-used-by-domain-test',
  maxAttempts: 2,
  proofRetentionDays: 2_555,
};

const task = () => createAlumniCleanupTask({
  sourceEventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6',
  tenantId: 'tenant-001',
  consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
  consentVersion: 2,
  consentPurpose: 'alumni_network',
  terminationReason: 'withdrawn',
  terminatedAt: '2026-07-27T00:00:00.000Z',
  target,
});

describe('校友下游清理领域', () => {
  it('按租户、授权、版本、目的和目标形成稳定任务与幂等键', () => {
    expect(task()).toEqual(task());
    expect(task()).toMatchObject({
      status: 'pending',
      attempts: 0,
      targetCode: 'crm',
      policyVersion: 'privacy-v1',
    });
    expect(cleanupIdempotencyKey(task())).toHaveLength(63);
  });

  it('只接受满足保留期限的不可变证明并形成终态', () => {
    const claimed = {
      ...task(),
      status: 'dispatching' as const,
      lockedAt: '2026-07-27T00:01:00.000Z',
      lockedBy: 'worker-001',
    };
    const completed = completeAlumniCleanupTask(claimed, {
      proofDigest: 'a'.repeat(43),
      action: 'crypto_shredded',
      storage: 'immutable_worm',
      completedAt: '2026-07-27T00:02:00.000Z',
      retentionUntil: '2033-07-26T00:02:00.000Z',
      keyId: 'key-v1',
    }, 'worker-001', new Date('2026-07-27T00:03:00.000Z'));
    expect(completed).toMatchObject({
      status: 'completed',
      proofDigest: 'a'.repeat(43),
      lockedBy: null,
      version: 2,
    });
  });

  it('失败退避、到上限死信且仅 dead 可受控重放', () => {
    const claimed = {
      ...task(),
      status: 'dispatching' as const,
      lockedAt: '2026-07-27T00:01:00.000Z',
      lockedBy: 'worker-001',
    };
    const retry = failAlumniCleanupTask(
      claimed,
      'worker-001',
      'CLEANUP_GATEWAY_TIMEOUT',
      new Date('2026-07-27T00:02:00.000Z'),
    );
    expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    const dead = failAlumniCleanupTask({
      ...retry,
      status: 'dispatching',
      lockedAt: '2026-07-27T00:03:00.000Z',
      lockedBy: 'worker-001',
    }, 'worker-001', 'CLEANUP_GATEWAY_TIMEOUT', new Date('2026-07-27T00:04:00.000Z'));
    expect(dead).toMatchObject({ status: 'dead', attempts: 2 });
    expect(replayAlumniCleanupTask(
      dead,
      dead.version,
      'CHANNEL_OWNER_APPROVED',
      new Date('2026-07-27T00:05:00.000Z'),
    )).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
