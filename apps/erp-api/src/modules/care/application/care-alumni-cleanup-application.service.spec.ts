import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createAlumniCleanupTask } from '../domain/index.js';
import { CareAlumniCleanupApplicationService } from './care-alumni-cleanup-application.service.js';

const target = {
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: 'unused-in-application-test',
  maxAttempts: 3,
  proofRetentionDays: 2_555,
};
const pending = createAlumniCleanupTask({
  sourceEventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6',
  tenantId: 'tenant-001',
  consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
  consentVersion: 2,
  consentPurpose: 'alumni_network',
  terminationReason: 'withdrawn',
  terminatedAt: '2026-07-27T00:00:00.000Z',
  target,
});
const claimed = Object.freeze({
  ...pending,
  status: 'dispatching' as const,
  lockedAt: '2026-07-27T00:01:00.000Z',
  lockedBy: 'worker-001',
  version: 2,
  updatedAt: '2026-07-27T00:01:00.000Z',
});

function fixture(input: {
  readonly gateway?: ReturnType<typeof vi.fn>;
  readonly replace?: ReturnType<typeof vi.fn>;
} = {}) {
  const context = new TenantContextService();
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const consents = {
    findById: vi.fn().mockResolvedValue({
      id: claimed.consentId,
      tenantId: claimed.tenantId,
      personId: 'person-hidden',
      careCaseId: 'care-hidden',
      purpose: claimed.consentPurpose,
      channels: ['email'],
      consentVersion: 'v1',
      consentEvidenceId: 'evidence-hidden',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      withdrawnAt: claimed.terminatedAt,
      expiredAt: null,
      status: 'withdrawn',
      version: claimed.consentVersion,
    }),
  };
  const replaceClaimed = input.replace ?? vi.fn().mockResolvedValue(undefined);
  const tasks = {
    claim: vi.fn().mockResolvedValue(claimed),
    findById: vi.fn().mockResolvedValue(claimed),
    findByConsentId: vi.fn().mockResolvedValue([claimed]),
    replaceClaimed,
  };
  const gateway = {
    execute: input.gateway ?? vi.fn().mockResolvedValue({
      proofDigest: 'A'.repeat(43),
      action: 'anonymized',
      storage: 'immutable_worm',
      completedAt: '2026-07-27T00:02:00.000Z',
      retentionUntil: '2033-07-27T00:02:00.000Z',
      keyId: 'proof-key-v1',
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const queue = { scheduleAlumniCleanup: vi.fn().mockResolvedValue(undefined) };
  const metrics = { recordCareAlumniCleanup: vi.fn() };
  const service = new CareAlumniCleanupApplicationService(
    connection as never,
    context,
    consents as never,
    tasks as never,
    { require: vi.fn().mockReturnValue(target), targets: vi.fn().mockReturnValue([target]) } as never,
    outbox as never,
    gateway as never,
    queue as never,
    metrics as never,
  );
  return {
    context,
    service,
    gateway,
    tasks,
    outbox,
    queue,
    metrics,
  };
}

const trusted = {
  tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
  actor: {
    actorId: 'system:cleanup',
    actorType: 'system_job' as const,
    tenantId: 'tenant-001',
    roleCodes: [],
    scopes: ['erp:care:alumni:cleanup:dispatch', 'erp:care:alumni:cleanup:read'],
    departmentIds: [],
    traceId: 'trace-001',
  },
};

describe('CareAlumniCleanupApplicationService', () => {
  it('成功证明与 completed 事件在同一事务固化', async () => {
    const store = fixture();
    const result = await store.context.run(
      trusted,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.status).toBe('completed');
    expect(store.tasks.replaceClaimed).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.alumni_cleanup.completed' }),
      expect.anything(),
    );
  });

  it('外部成功后的本地事务故障不被回写成外部失败', async () => {
    const persistenceFailure = new Error('MONGO_COMMIT_UNKNOWN');
    const replace = vi.fn().mockRejectedValue(persistenceFailure);
    const store = fixture({ replace });
    await expect(store.context.run(
      trusted,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toBe(persistenceFailure);
    expect(store.gateway.execute).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
  });

  it('网关失败持久化退避状态并重排同一任务', async () => {
    const store = fixture({
      gateway: vi.fn().mockRejectedValue(new Error('CARE_ALUMNI_CLEANUP_GATEWAY_FAILED')),
    });
    const result = await store.context.run(
      trusted,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result).toMatchObject({ status: 'pending', attempts: 1 });
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledWith(result);
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('MCP 摘要只返回状态与计数，不返回目标或证明', async () => {
    const store = fixture();
    const result = await store.context.run(
      trusted,
      () => store.service.getStatusForMcp(claimed.consentId),
    );
    expect(result).toEqual({
      consentStatus: 'withdrawn',
      cleanupStatus: 'in_progress',
      counts: { pending: 0, dispatching: 1, completed: 0, dead: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(/target|proof|person|channel/iu);
  });

  it('状态只统计当前授权版本和当前登记政策，旧政策死信不污染完成结论', async () => {
    const store = fixture();
    const currentCompleted = Object.freeze({
      ...claimed,
      status: 'completed' as const,
      lockedAt: null,
      lockedBy: null,
      proofDigest: 'A'.repeat(43),
      proofAction: 'anonymized' as const,
      proofStorage: 'immutable_worm' as const,
      proofCompletedAt: '2026-07-27T00:02:00.000Z',
      proofRetentionUntil: '2033-07-27T00:02:00.000Z',
      proofKeyId: 'proof-key-v1',
    });
    const staleDead = Object.freeze({
      ...pending,
      id: 'C'.repeat(43),
      policyVersion: 'privacy-v0',
      status: 'dead' as const,
      attempts: 3,
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_GATEWAY_FAILED',
    });
    store.tasks.findByConsentId.mockResolvedValue([staleDead, currentCompleted]);
    const result = await store.context.run(
      trusted,
      () => store.service.getStatus(claimed.consentId),
    );
    expect(result).toMatchObject({
      cleanupStatus: 'completed',
      counts: { pending: 0, dispatching: 0, completed: 1, dead: 0 },
      targets: [{ targetCode: 'crm', policyVersion: 'privacy-v1', status: 'completed' }],
    });
  });
});
