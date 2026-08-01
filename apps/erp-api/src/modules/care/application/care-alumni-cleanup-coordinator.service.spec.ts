import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createAlumniCleanupTask,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareAlumniCleanupCoordinatorService } from './care-alumni-cleanup-coordinator.service.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C6';
const CONSENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C4';
const TENANT_ID = 'tenant-001';
const TERMINATED_AT = '2026-07-27T00:00:00.000Z';
const event = Object.freeze({
  eventId: EVENT_ID,
  tenantId: TENANT_ID,
  aggregateType: 'care',
  aggregateId: CONSENT_ID,
  aggregateVersion: 2,
  eventType: 'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
  envelope: {
    specversion: '1.0',
    id: EVENT_ID,
    source: '//gaoq-erp/care-module',
    tenantId: TENANT_ID,
    type: 'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
    subject: `tenant/${TENANT_ID}/care/${CONSENT_ID}`,
    time: TERMINATED_AT,
    datacontenttype: 'application/json',
    traceId: 'trace-001',
    idempotencyKey: `${TENANT_ID}:withdrawn:${CONSENT_ID}:2`,
    schemaVersion: '1',
    data: {
      tenantId: TENANT_ID,
      aggregateId: CONSENT_ID,
      version: 2,
      careCaseId: 'care-case-001',
      purpose: 'alumni_network',
      channels: ['email'],
      status: 'withdrawn',
      expiresAt: '2027-07-27T00:00:00.000Z',
    },
  },
  attempts: 0,
});
const target = Object.freeze({
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: 'unused-in-coordinator-test',
  maxAttempts: 3,
  proofRetentionDays: 2_555,
});
const pending = createAlumniCleanupTask({
  sourceEventId: EVENT_ID,
  tenantId: TENANT_ID,
  consentId: CONSENT_ID,
  consentVersion: 2,
  consentPurpose: 'alumni_network',
  terminationReason: 'withdrawn',
  terminatedAt: TERMINATED_AT,
  target,
});

function chain<T>(value: T) {
  const result = {
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  result.session.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function toRecord(
  task: AlumniCleanupTask,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...task,
    terminatedAt: new Date(task.terminatedAt),
    nextAttemptAt: new Date(task.nextAttemptAt),
    lockedAt: task.lockedAt === null ? null : new Date(task.lockedAt),
    proofCompletedAt:
      task.proofCompletedAt === null ? null : new Date(task.proofCompletedAt),
    proofRetentionUntil:
      task.proofRetentionUntil === null
        ? null
        : new Date(task.proofRetentionUntil),
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    ...overrides,
  };
}

function outboxUpdateAt(
  updateOne: ReturnType<typeof vi.fn>,
  index = 0,
): Readonly<{
  filter: Readonly<Record<string, unknown>>;
  set: Readonly<Record<string, unknown>>;
}> {
  const call = (updateOne.mock.calls as unknown[][]).at(index);
  const filter = call?.[0];
  const update = call?.[1];
  if (
    typeof filter !== 'object' ||
    filter === null ||
    typeof update !== 'object' ||
    update === null
  ) throw new Error('TEST_OUTBOX_UPDATE_CALL_INVALID');
  const set = (update as Record<string, unknown>).$set;
  if (typeof set !== 'object' || set === null) {
    throw new Error('TEST_OUTBOX_UPDATE_SET_INVALID');
  }
  return {
    filter: filter as Readonly<Record<string, unknown>>,
    set: set as Readonly<Record<string, unknown>>,
  };
}

function fixture(input: {
  readonly claimedEvents?: readonly unknown[];
  readonly consent?: Record<string, unknown> | null;
  readonly targets?: readonly typeof target[];
  readonly taskUpsert?: { readonly upsertedCount: number };
  readonly existingTask?: Record<string, unknown> | null;
  readonly transaction?: 'run' | 'empty' | 'retry';
  readonly outboxUpdates?: readonly { readonly matchedCount: number }[];
  readonly queueFailure?: Error;
  readonly reconcileCandidates?: readonly Record<string, unknown>[];
  readonly recoveredTask?: Record<string, unknown> | null;
  readonly backlog?: readonly {
    readonly _id: 'pending' | 'dispatching' | 'dead';
    readonly count: number;
    readonly oldestAt: Date;
  }[];
} = {}) {
  const claimedEvents = [...(input.claimedEvents ?? [event])];
  const outboxUpdate = vi.fn();
  for (const result of input.outboxUpdates ?? []) {
    outboxUpdate.mockResolvedValueOnce(result);
  }
  outboxUpdate.mockResolvedValue({ matchedCount: 1 });
  const outbox = {
    findOneAndUpdate: vi.fn().mockImplementation(() =>
      chain(claimedEvents.shift() ?? null)),
    updateOne: outboxUpdate,
  };
  const tasks = {
    updateOne: vi.fn().mockResolvedValue(
      input.taskUpsert ?? { upsertedCount: 1 },
    ),
    findOne: vi.fn().mockImplementation(() =>
      chain(input.existingTask ?? null)),
    find: vi.fn().mockImplementation(() =>
      chain(input.reconcileCandidates ?? [])),
    findOneAndUpdate: vi.fn().mockImplementation(() =>
      chain(input.recoveredTask ?? null)),
    aggregate: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(input.backlog ?? []),
    }),
  };
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      if (input.transaction === 'empty') return;
      await operation();
      if (input.transaction === 'retry') await operation();
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const queue = {
    scheduleAlumniCleanup: input.queueFailure === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(input.queueFailure),
  };
  const outboxWriter = { append: vi.fn().mockResolvedValue(undefined) };
  const metrics = {
    recordCareAlumniCleanup: vi.fn(),
    setCareAlumniCleanupBacklog: vi.fn(),
  };
  const context = new TenantContextService();
  const service = new CareAlumniCleanupCoordinatorService(
    { startSession: vi.fn().mockResolvedValue(session) } as never,
    outbox as never,
    tasks as never,
    context,
    {
      findById: vi.fn().mockResolvedValue(input.consent === undefined
        ? {
            id: CONSENT_ID,
            tenantId: TENANT_ID,
            purpose: 'alumni_network',
            version: 2,
            status: 'withdrawn',
            withdrawnAt: TERMINATED_AT,
            expiredAt: null,
          }
        : input.consent),
    } as never,
    {
      targets: vi.fn().mockReturnValue(input.targets ?? [target]),
    } as never,
    outboxWriter as never,
    queue as never,
    metrics as never,
  );
  return {
    service,
    context,
    outbox,
    tasks,
    session,
    queue,
    outboxWriter,
    metrics,
  };
}

describe('CareAlumniCleanupCoordinatorService', () => {
  it('只消费撤回/到期 Outbox，并原子扇出登记目标后用最小任务入队', async () => {
    const store = fixture();

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);

    const updateCall = JSON.stringify(store.tasks.updateOne.mock.calls[0]);
    expect(updateCall).toContain(`"consentId":"${CONSENT_ID}"`);
    expect(updateCall).toContain('"consentVersion":2');
    expect(updateCall).toContain('"targetCode":"crm"');
    expect(updateCall).toContain('"$setOnInsert"');
    expect(updateCall).toContain('"upsert":true');
    expect(store.outboxWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.alumni_cleanup.scheduled' }),
      store.session,
    );
    const queued = JSON.stringify(
      store.queue.scheduleAlumniCleanup.mock.calls[0]?.[0],
    );
    expect(queued).toContain(`"tenantId":"${TENANT_ID}"`);
    expect(queued).toContain(`"consentId":"${CONSENT_ID}"`);
    expect(queued).toContain('"targetCode":"crm"');
    expect(queued).not.toMatch(
      /personId|consentEvidenceId|phone|emailAddress|proofObject/iu,
    );
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('没有待处理事件时刷新三类积压指标并结束批次', async () => {
    const oldestAt = new Date(Date.now() - 10_000);
    const store = fixture({
      claimedEvents: [],
      backlog: [
        { _id: 'pending', count: 2, oldestAt },
        { _id: 'dead', count: 1, oldestAt: new Date(Date.now() + 10_000) },
      ],
    });

    await expect(store.service.relayBatch('worker-001', 3)).resolves.toBe(0);

    expect(store.metrics.setCareAlumniCleanupBacklog).toHaveBeenCalledTimes(3);
    expect(store.metrics.setCareAlumniCleanupBacklog).toHaveBeenCalledWith(
      'pending',
      2,
      expect.any(Number),
    );
    expect(store.metrics.setCareAlumniCleanupBacklog).toHaveBeenCalledWith(
      'dispatching',
      0,
      0,
    );
    expect(store.metrics.setCareAlumniCleanupBacklog).toHaveBeenCalledWith(
      'dead',
      1,
      0,
    );
  });

  it.each([
    ['', 1, 'CARE_ALUMNI_CLEANUP_WORKER_INVALID'],
    ['bad worker', 1, 'CARE_ALUMNI_CLEANUP_WORKER_INVALID'],
    ['worker-001', 0, 'CARE_ALUMNI_CLEANUP_RELAY_LIMIT_INVALID'],
    ['worker-001', 101, 'CARE_ALUMNI_CLEANUP_RELAY_LIMIT_INVALID'],
    ['worker-001', 1.5, 'CARE_ALUMNI_CLEANUP_RELAY_LIMIT_INVALID'],
  ])('拒绝非法 Relay 参数 %#', async (workerId, limit, code) => {
    const store = fixture();
    await expect(store.service.relayBatch(workerId, limit)).rejects.toThrow(code);
    expect(store.outbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, 1_001])('拒绝非法对账批量 %s', async (limit) => {
    const store = fixture();
    await expect(store.service.reconcileAndEnqueue(limit)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_RECONCILE_LIMIT_INVALID',
    );
    expect(store.tasks.find).not.toHaveBeenCalled();
  });

  it('畸形事件立即释放认领并记录稳定错误码，不阻塞后续批次', async () => {
    const store = fixture({
      claimedEvents: [{ ...event, envelope: {} }],
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);

    const released = outboxUpdateAt(store.outbox.updateOne);
    expect(released.filter).toMatchObject({
      eventId: EVENT_ID,
      status: 'dispatching',
      lockedBy: 'worker-001',
    });
    expect(released.set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_SOURCE_EVENT_INVALID',
      lockedAt: null,
      lockedBy: null,
    });
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'relay',
      'retry',
    );
  });

  it('信封与 Outbox 元数据不一致时保留精确错误码', async () => {
    const store = fixture({
      claimedEvents: [{
        ...event,
        envelope: { ...event.envelope, subject: 'tenant/other/care/other' },
      }],
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);

    expect(outboxUpdateAt(store.outbox.updateOne).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_SOURCE_EVENT_MISMATCH',
    });
  });

  it.each([
    null,
    { version: 3, status: 'withdrawn', purpose: 'alumni_network', withdrawnAt: TERMINATED_AT },
    { version: 2, status: 'expired', purpose: 'alumni_network', withdrawnAt: TERMINATED_AT },
    { version: 2, status: 'withdrawn', purpose: 'rehire_contact', withdrawnAt: TERMINATED_AT },
    { version: 2, status: 'withdrawn', purpose: 'alumni_network', withdrawnAt: '2026-07-28T00:00:00.000Z' },
  ])('授权终态不匹配时失败关闭 %#', async (consent) => {
    const store = fixture({ consent });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.tasks.updateOne).not.toHaveBeenCalled();
    expect(outboxUpdateAt(store.outbox.updateOne).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_SOURCE_STATE_MISMATCH',
    });
  });

  it('到期事件使用 expiredAt 校验终止事实', async () => {
    const expired = {
      ...event,
      eventType: 'cn.gaoq.erp.care.alumni_consent.expired.v1',
      envelope: {
        ...event.envelope,
        type: 'cn.gaoq.erp.care.alumni_consent.expired.v1',
        data: { ...event.envelope.data, status: 'expired' },
      },
    };
    const store = fixture({
      claimedEvents: [expired],
      consent: {
        version: 2,
        status: 'expired',
        purpose: 'alumni_network',
        withdrawnAt: null,
        expiredAt: TERMINATED_AT,
      },
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledOnce();
  });

  it('未配置清理目标时释放事件并等待配置恢复', async () => {
    const store = fixture({ targets: [] });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(outboxUpdateAt(store.outbox.updateOne).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_TARGETS_REQUIRED',
    });
  });

  it('幂等重放复用一致的 pending 任务，不重复写 scheduled 事件', async () => {
    const store = fixture({
      taskUpsert: { upsertedCount: 0 },
      existingTask: toRecord(pending),
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);

    expect(store.outboxWriter.append).not.toHaveBeenCalled();
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.id, status: 'pending' }),
    );
  });

  it('幂等重放遇到已完成任务时只提交来源事件，不重复入队', async () => {
    const completed = {
      ...pending,
      status: 'completed',
      proofDigest: 'A'.repeat(43),
      proofAction: 'anonymized',
      proofStorage: 'immutable_worm',
      proofCompletedAt: TERMINATED_AT,
      proofRetentionUntil: '2033-07-27T00:00:00.000Z',
      proofKeyId: 'proof-key-v1',
    } as const;
    const store = fixture({
      taskUpsert: { upsertedCount: 0 },
      existingTask: toRecord(completed),
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
  });

  it('幂等键命中不同控制上下文时失败关闭', async () => {
    const store = fixture({
      taskUpsert: { upsertedCount: 0 },
      existingTask: toRecord(pending, { controlDigest: 'B'.repeat(43) }),
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(outboxUpdateAt(store.outbox.updateOne, -1).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_TASK_CONTEXT_MISMATCH',
    });
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('事务没有执行回调时不得误报扇出成功', async () => {
    const store = fixture({ transaction: 'empty' });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);

    expect(outboxUpdateAt(store.outbox.updateOne).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_TRANSACTION_EMPTY',
    });
    expect(store.queue.scheduleAlumniCleanup).not.toHaveBeenCalled();
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('事务自动重试时只入队最终成功尝试生成的任务', async () => {
    const store = fixture({ transaction: 'retry' });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);

    expect(store.session.withTransaction).toHaveBeenCalledOnce();
    expect(store.tasks.updateOne).toHaveBeenCalledTimes(2);
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledOnce();
  });

  it('事务内来源认领丢失时回滚并释放原认领', async () => {
    const store = fixture({
      outboxUpdates: [{ matchedCount: 0 }, { matchedCount: 1 }],
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.outbox.updateOne).toHaveBeenCalledTimes(2);
    expect(outboxUpdateAt(store.outbox.updateOne, -1).set).toMatchObject({
      lastErrorCode: 'CARE_ALUMNI_CLEANUP_SOURCE_CLAIM_LOST',
    });
  });

  it('释放事件时认领已丢失必须显式失败', async () => {
    const store = fixture({
      targets: [],
      outboxUpdates: [{ matchedCount: 0 }],
    });

    await expect(
      store.service.relayBatch('worker-001', 1),
    ).rejects.toThrow('CARE_ALUMNI_CLEANUP_SOURCE_CLAIM_LOST');
  });

  it('达到 Relay 重试上限后进入 dead，不再计算未来退避时间', async () => {
    const store = fixture({
      claimedEvents: [{ ...event, attempts: 5 }],
      targets: [],
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);

    const release = outboxUpdateAt(store.outbox.updateOne).set;
    expect(release).toMatchObject({ status: 'dead', attempts: 6 });
    expect(release.nextAttemptAt).toBeInstanceOf(Date);
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'relay',
      'dead',
    );
  });

  it('队列暂时不可用不回滚已提交事务，依赖对账窗口恢复', async () => {
    const store = fixture({
      queueFailure: new Error('CARE_QUEUE_TEMPORARILY_UNAVAILABLE'),
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'relay',
      'success',
    );
    expect(outboxUpdateAt(store.outbox.updateOne).set).toMatchObject({
      status: 'dispatched',
    });
  });

  it('对账直接调度到期 pending 任务并记录成功', async () => {
    const store = fixture({
      claimedEvents: [],
      reconcileCandidates: [toRecord(pending)],
    });

    await expect(store.service.reconcileAndEnqueue(20)).resolves.toBe(1);

    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.id, status: 'pending' }),
    );
    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'reconcile',
      'success',
    );
  });

  it('对账抢回过期 dispatching 锁后使用递增版本重新入队', async () => {
    const stale = {
      ...pending,
      status: 'dispatching' as const,
      lockedAt: '2026-07-27T00:01:00.000Z',
      lockedBy: 'stale-worker',
      version: 2,
    };
    const recovered = {
      ...pending,
      version: 3,
      nextAttemptAt: new Date().toISOString(),
    };
    const store = fixture({
      claimedEvents: [],
      reconcileCandidates: [toRecord(stale)],
      recoveredTask: toRecord(recovered),
    });

    await expect(store.service.reconcileAndEnqueue()).resolves.toBe(1);

    expect(store.tasks.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(store.queue.scheduleAlumniCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pending.id,
        status: 'pending',
        version: 3,
      }),
    );
  });

  it('对账认领竞争和队列故障均保留任务并报告 retry', async () => {
    const stale = {
      ...pending,
      status: 'dispatching' as const,
      lockedAt: '2026-07-27T00:01:00.000Z',
      lockedBy: 'stale-worker',
      version: 2,
    };
    const store = fixture({
      claimedEvents: [],
      reconcileCandidates: [toRecord(stale), toRecord(pending)],
      recoveredTask: null,
      queueFailure: new Error('CARE_QUEUE_TEMPORARILY_UNAVAILABLE'),
    });

    await expect(store.service.reconcileAndEnqueue()).resolves.toBe(0);

    expect(store.metrics.recordCareAlumniCleanup).toHaveBeenCalledWith(
      'reconcile',
      'retry',
    );
  });
});
