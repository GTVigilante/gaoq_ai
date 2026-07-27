import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { AuditAnchorProcessor } from './audit-anchor.processor.js';
import { AuditAnchorScheduler } from './audit-anchor.scheduler.js';
import type { AuditAnchorService } from './audit-anchor.service.js';
import {
  AUDIT_ANCHOR_JOB,
  AUDIT_MAINTENANCE_QUEUE,
} from './audit-maintenance.queue.js';

const job = (name: string): Job<Record<string, never>, number, typeof AUDIT_ANCHOR_JOB> => ({
  name,
  data: {},
} as Job<Record<string, never>, number, typeof AUDIT_ANCHOR_JOB>);

function fixture(enabled = true) {
  const anchorPendingTenants = vi.fn().mockResolvedValue(3);
  const isEnabled = vi.fn().mockReturnValue(enabled);
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const anchors = {
    anchorPendingTenants,
    isEnabled,
  } as unknown as AuditAnchorService;
  return {
    anchors,
    anchorPendingTenants,
    isEnabled,
    upsertJobScheduler,
    processor: new AuditAnchorProcessor(anchors),
    scheduler: new AuditAnchorScheduler(
      { upsertJobScheduler } as unknown as Queue<Record<string, never>, number, string>,
      anchors,
    ),
  };
}

describe('审计链锚定 Worker 入口', () => {
  it('只以固定批量上限处理审计锚定任务并返回处理数量', async () => {
    const store = fixture();

    await expect(store.processor.process(job(AUDIT_ANCHOR_JOB))).resolves.toBe(3);

    expect(store.anchorPendingTenants).toHaveBeenCalledOnce();
    expect(store.anchorPendingTenants).toHaveBeenCalledWith(100);
  });

  it('未知任务在调用应用服务前以稳定错误码失败关闭', async () => {
    const store = fixture();

    await expect(store.processor.process(job('unknown-job')))
      .rejects.toThrow('AUDIT_MAINTENANCE_JOB_INVALID');

    expect(store.anchorPendingTenants).not.toHaveBeenCalled();
  });

  it('锚定失败原样交给 BullMQ 重试，不在 Processor 内吞掉或改写', async () => {
    const store = fixture();
    const failure = new Error('AUDIT_WORM_UNAVAILABLE');
    store.anchorPendingTenants.mockRejectedValueOnce(failure);

    await expect(store.processor.process(job(AUDIT_ANCHOR_JOB))).rejects.toBe(failure);
  });

  it('WORM 未启用时不注册空转调度', async () => {
    const store = fixture(false);

    await expect(store.scheduler.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(store.isEnabled).toHaveBeenCalledOnce();
    expect(store.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('WORM 启用时以固定队列契约幂等注册六小时调度', async () => {
    const store = fixture();

    await expect(store.scheduler.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(AUDIT_MAINTENANCE_QUEUE).toBe('audit-maintenance');
    expect(store.upsertJobScheduler).toHaveBeenCalledWith(
      'audit-maintenance:anchor-pending',
      { every: 21_600_000 },
      {
        name: AUDIT_ANCHOR_JOB,
        data: {},
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 1_000,
        },
      },
    );
  });

  it('调度注册失败原样阻止 Worker 启动，禁止静默缺失审计锚定任务', async () => {
    const store = fixture();
    const failure = new Error('REDIS_UNAVAILABLE');
    store.upsertJobScheduler.mockRejectedValueOnce(failure);

    await expect(store.scheduler.onApplicationBootstrap()).rejects.toBe(failure);
  });
});
