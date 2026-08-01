import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { CareAlumniCleanupTarget } from '../../../config/care-alumni-cleanup-targets.js';
import {
  TenantContextService,
  type TrustedRequestContext,
} from '../../../core/tenant/tenant-context.service.js';
import {
  createAlumniCleanupTask,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareWriteConflictError } from '../persistence/care.repositories.js';
import { CareAlumniCleanupApplicationService } from './care-alumni-cleanup-application.service.js';

const target: CareAlumniCleanupTarget = Object.freeze({
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: 'unused-in-application-test',
  maxAttempts: 3,
  proofRetentionDays: 2_555,
});
const secondaryTarget: CareAlumniCleanupTarget = Object.freeze({
  ...target,
  targetCode: 'notification',
  endpoint: 'https://privacy-notification.example.net',
});
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
const consent = Object.freeze({
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
  status: 'withdrawn' as const,
  version: claimed.consentVersion,
});
const proof = Object.freeze({
  proofDigest: 'A'.repeat(43),
  action: 'anonymized' as const,
  storage: 'immutable_worm' as const,
  completedAt: '2026-07-27T00:02:00.000Z',
  retentionUntil: '2033-07-27T00:02:00.000Z',
  keyId: 'proof-key-v1',
});

const trusted: TrustedRequestContext = {
  tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
  actor: {
    actorId: 'system:cleanup',
    actorType: 'system_job' as const,
    tenantId: 'tenant-001',
    roleCodes: [],
    scopes: [
      'erp:care:alumni:cleanup:dispatch',
      'erp:care:alumni:cleanup:read',
    ],
    departmentIds: [],
    traceId: 'trace-001',
  },
};

function completedTask(task: AlumniCleanupTask = claimed): AlumniCleanupTask {
  return Object.freeze({
    ...task,
    status: 'completed',
    lockedAt: null,
    lockedBy: null,
    proofDigest: proof.proofDigest,
    proofAction: proof.action,
    proofStorage: proof.storage,
    proofCompletedAt: proof.completedAt,
    proofRetentionUntil: proof.retentionUntil,
    proofKeyId: proof.keyId,
    version: task.version + 1,
  });
}

function fixture(input: {
  readonly claim?: AlumniCleanupTask | null;
  readonly existing?: AlumniCleanupTask | null;
  readonly consent?: Record<string, unknown> | null;
  readonly consentTasks?: readonly AlumniCleanupTask[];
  readonly configuredTargets?: readonly CareAlumniCleanupTarget[];
  readonly targetResult?: CareAlumniCleanupTarget | Error;
  readonly gateway?: ReturnType<typeof vi.fn>;
  readonly replace?: ReturnType<typeof vi.fn>;
  readonly transaction?: 'run' | 'empty';
} = {}) {
  const context = new TenantContextService();
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      if (input.transaction !== 'empty') await operation();
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const consents = {
    findById: vi.fn().mockResolvedValue(
      input.consent === undefined ? consent : input.consent,
    ),
  };
  const replaceClaimed = input.replace ?? vi.fn().mockResolvedValue(undefined);
  const tasks = {
    claim: vi.fn().mockResolvedValue(
      input.claim === undefined ? claimed : input.claim,
    ),
    findById: vi.fn().mockResolvedValue(
      input.existing === undefined ? claimed : input.existing,
    ),
    findByConsentId: vi.fn().mockResolvedValue(
      input.consentTasks ?? [claimed],
    ),
    replaceClaimed,
  };
  const gateway = {
    execute: input.gateway ?? vi.fn().mockResolvedValue(proof),
  };
  const registry = {
    require: vi.fn().mockImplementation(() => {
      if (input.targetResult instanceof Error) throw input.targetResult;
      return input.targetResult ?? target;
    }),
    targets: vi.fn().mockReturnValue(input.configuredTargets ?? [target]),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const queue = { scheduleAlumniCleanup: vi.fn().mockResolvedValue(undefined) };
  const metrics = { recordCareAlumniCleanup: vi.fn() };
  const service = new CareAlumniCleanupApplicationService(
    connection as never,
    context,
    consents as never,
    tasks as never,
    registry as never,
    outbox as never,
    gateway as never,
    queue as never,
    metrics as never,
  );
  return {
    context,
    service,
    connection,
    session,
    consents,
    registry,
    gateway,
    tasks,
    outbox,
    queue,
    metrics,
  };
}

function run<T>(
  store: ReturnType<typeof fixture>,
  operation: () => Promise<T>,
  identity: TrustedRequestContext = trusted,
): Promise<T> {
  return store.context.run(identity, operation);
}

describe('CareAlumniCleanupApplicationService', () => {
  it('成功证明与 completed 事件在同一事务固化', async () => {
    const store = fixture();
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.status).toBe('completed');
    expect(store.tasks.replaceClaimed).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.alumni_cleanup.completed' }),
      store.session,
    );
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'dispatch',
      'completed',
      expect.any(Number),
    );
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('外部成功后的本地事务故障不被回写成外部失败', async () => {
    const persistenceFailure = new Error('MONGO_COMMIT_UNKNOWN');
    const replace = vi.fn().mockRejectedValue(persistenceFailure);
    const store = fixture({ replace });
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toBe(persistenceFailure);
    expect(store.gateway.execute).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('网关失败持久化退避状态并重排同一任务', async () => {
    const store = fixture({
      gateway: vi.fn().mockRejectedValue(
        new Error('CARE_ALUMNI_CLEANUP_GATEWAY_FAILED'),
      ),
    });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_GATEWAY_FAILED',
    });
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledWith(result);
    expect(store.outbox.append).not.toHaveBeenCalled();
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'dispatch',
      'retry',
      expect.any(Number),
    );
  });

  it('达到目标重试上限后进入 dead 并发布终态事件', async () => {
    const lastAttempt = Object.freeze({
      ...claimed,
      attempts: claimed.maxAttempts - 1,
    });
    const store = fixture({
      claim: lastAttempt,
      gateway: vi.fn().mockRejectedValue(
        new Error('CARE_ALUMNI_CLEANUP_GATEWAY_FAILED'),
      ),
    });

    const result = await run(
      store,
      () => store.service.dispatchTask(lastAttempt.id, 'worker-001'),
    );

    expect(result).toMatchObject({
      status: 'dead',
      attempts: claimed.maxAttempts,
    });
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.alumni_cleanup.dead' }),
      store.session,
    );
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'dispatch',
      'dead',
      expect.any(Number),
    );
  });

  it.each([
    {
      error: { response: { code: 'UPSTREAM_PRIVACY_DENIED' } },
      expected: 'UPSTREAM_PRIVACY_DENIED',
    },
    {
      error: { response: { code: 'invalid-code' } },
      expected: 'CARE_ALUMNI_CLEANUP_FAILED',
    },
    {
      error: new Error('not a stable code'),
      expected: 'CARE_ALUMNI_CLEANUP_FAILED',
    },
  ])('只持久化白名单失败码 %#', async ({ error, expected }) => {
    const store = fixture({
      gateway: vi.fn().mockRejectedValue(error),
    });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.lastErrorCode).toBe(expected);
  });

  it.each([
    ['service actor', {
      ...trusted,
      actor: { ...trusted.actor, actorType: 'service' as const },
    }],
    ['scope missing', {
      ...trusted,
      actor: { ...trusted.actor, scopes: ['erp:care:alumni:cleanup:read'] },
    }],
  ])('清理投递拒绝非可信系统任务：%s', async (_name, identity) => {
    const store = fixture();
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
      identity,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.tasks.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['short-id', 'worker-001', 'CARE_ALUMNI_CLEANUP_TASK_ID_INVALID'],
    [claimed.id, '', 'CARE_ALUMNI_CLEANUP_WORKER_INVALID'],
    [claimed.id, 'bad worker', 'CARE_ALUMNI_CLEANUP_WORKER_INVALID'],
  ])('清理投递拒绝非法内部标识 %#', async (taskId, workerId, code) => {
    const store = fixture();
    try {
      await run(
        store,
        () => store.service.dispatchTask(taskId, workerId),
      );
      throw new Error('TEST_EXPECTED_BAD_REQUEST');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BadRequestException);
      if (!(error instanceof BadRequestException)) throw error;
      expect(error.getResponse()).toMatchObject({ code });
    }
    expect(store.tasks.claim).not.toHaveBeenCalled();
  });

  it('任务不存在时返回稳定 NotFound 错误', async () => {
    const store = fixture({ claim: null, existing: null });
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [completedTask(), 'deduplicated'],
    [pending, 'deferred'],
  ] as const)('未取得认领时返回当前终态并记录 %s', async (existing, metric) => {
    const store = fixture({ claim: null, existing });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result).toBe(existing);
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'dispatch',
      metric,
      expect.any(Number),
    );
    expect(store.gateway.execute).not.toHaveBeenCalled();
  });

  it('授权不存在时转为受控重试，不调用下游', async () => {
    const store = fixture({ consent: null });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result).toMatchObject({
      status: 'pending',
      lastErrorCode: 'CARE_ALUMNI_CONSENT_NOT_FOUND',
    });
    expect(store.gateway.execute).not.toHaveBeenCalled();
  });

  it.each([
    { version: 3 },
    { status: 'expired' },
    { purpose: 'rehire_contact' },
    { withdrawnAt: '2026-07-28T00:00:00.000Z' },
  ])('授权源状态变化时失败关闭 %#', async (override) => {
    const store = fixture({ consent: { ...consent, ...override } });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.lastErrorCode).toBe(
      'CARE_ALUMNI_CLEANUP_SOURCE_STATE_MISMATCH',
    );
    expect(store.gateway.execute).not.toHaveBeenCalled();
  });

  it('到期任务使用 expiredAt 绑定终止事实', async () => {
    const expiredClaim = Object.freeze({
      ...claimed,
      terminationReason: 'expired' as const,
    });
    const store = fixture({
      claim: expiredClaim,
      consent: {
        ...consent,
        status: 'expired',
        withdrawnAt: null,
        expiredAt: claimed.terminatedAt,
      },
    });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.status).toBe('completed');
  });

  it.each([
    { policyVersion: 'privacy-v2' },
    { maxAttempts: 4 },
    { proofRetentionDays: 3_000 },
  ])('目标登记策略变化时禁止沿用旧任务 %#', async (override) => {
    const store = fixture({
      targetResult: { ...target, ...override },
    });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.lastErrorCode).toBe(
      'CARE_ALUMNI_CLEANUP_SOURCE_STATE_MISMATCH',
    );
    expect(store.gateway.execute).not.toHaveBeenCalled();
  });

  it('目标已撤销登记时按稳定错误码重试', async () => {
    const store = fixture({
      targetResult: new Error('CARE_ALUMNI_CLEANUP_TARGET_NOT_REGISTERED'),
    });
    const result = await run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    );
    expect(result.lastErrorCode).toBe(
      'CARE_ALUMNI_CLEANUP_TARGET_NOT_REGISTERED',
    );
  });

  it('无效证明在外部成功后失败关闭，且不得伪造本地失败终态', async () => {
    const store = fixture({
      gateway: vi.fn().mockResolvedValue({
        ...proof,
        proofDigest: 'invalid',
      }),
    });
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toThrow('CARE_ALUMNI_CLEANUP_PROOF_DIGEST_INVALID');
    expect(store.tasks.replaceClaimed).not.toHaveBeenCalled();
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
  });

  it('MCP 摘要只返回状态与计数，不返回目标或证明', async () => {
    const store = fixture();
    const result = await run(
      store,
      () => store.service.getStatusForMcp(claimed.consentId),
    );
    expect(result).toEqual({
      consentStatus: 'withdrawn',
      cleanupStatus: 'in_progress',
      counts: { pending: 0, dispatching: 1, completed: 0, dead: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(/target|proof|person|channel/iu);
  });

  it('状态只统计当前授权版本和当前登记政策', async () => {
    const currentCompleted = completedTask();
    const staleDead = Object.freeze({
      ...pending,
      id: 'C'.repeat(43),
      policyVersion: 'privacy-v0',
      status: 'dead' as const,
      attempts: 3,
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_GATEWAY_FAILED',
    });
    const store = fixture({
      consentTasks: [staleDead, currentCompleted],
    });
    const result = await run(
      store,
      () => store.service.getStatus(claimed.consentId),
    );
    expect(result).toMatchObject({
      cleanupStatus: 'completed',
      counts: { pending: 0, dispatching: 0, completed: 1, dead: 0 },
      targets: [{
        targetCode: 'crm',
        policyVersion: 'privacy-v1',
        status: 'completed',
      }],
    });
  });

  it.each([
    {
      name: 'active',
      consentOverride: { status: 'active' },
      tasks: [],
      targets: [target],
      expected: 'not_required',
    },
    {
      name: 'configuration',
      consentOverride: {},
      tasks: [],
      targets: [],
      expected: 'configuration_required',
    },
    {
      name: 'dead',
      consentOverride: {},
      tasks: [{
        ...pending,
        status: 'dead',
        attempts: 3,
        lastErrorCode: 'CARE_ALUMNI_CLEANUP_GATEWAY_FAILED',
      }],
      targets: [target],
      expected: 'attention_required',
    },
    {
      name: 'partial completion',
      consentOverride: {},
      tasks: [completedTask()],
      targets: [target, secondaryTarget],
      expected: 'in_progress',
    },
    {
      name: 'pending',
      consentOverride: {},
      tasks: [pending],
      targets: [target],
      expected: 'pending',
    },
  ])('计算 $name 清理状态', async ({
    consentOverride,
    tasks,
    targets,
    expected,
  }) => {
    const store = fixture({
      consent: { ...consent, ...consentOverride },
      consentTasks: tasks as AlumniCleanupTask[],
      configuredTargets: targets,
    });
    const result = await run(
      store,
      () => store.service.getStatus(claimed.consentId),
    );
    expect(result.cleanupStatus).toBe(expected);
  });

  it('状态读取要求授权存在且具有 read Scope', async () => {
    const missing = fixture({ consent: null });
    await expect(run(
      missing,
      () => missing.service.getStatus(claimed.consentId),
    )).rejects.toBeInstanceOf(NotFoundException);

    const denied = fixture();
    await expect(run(
      denied,
      () => denied.service.getStatus(claimed.consentId),
      {
        ...trusted,
        actor: { ...trusted.actor, scopes: [] },
      },
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('事务未执行回调时明确失败并释放 Session', async () => {
    const store = fixture({ transaction: 'empty' });
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toThrow('CARE_ALUMNI_CLEANUP_TRANSACTION_EMPTY');
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('仓储乐观锁冲突映射为稳定业务冲突', async () => {
    const store = fixture({
      replace: vi.fn().mockRejectedValue(new CareWriteConflictError()),
    });
    await expect(run(
      store,
      () => store.service.dispatchTask(claimed.id, 'worker-001'),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });
});
