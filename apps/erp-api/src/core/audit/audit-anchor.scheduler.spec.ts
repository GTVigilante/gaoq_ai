import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AuditAnchorService } from './audit-anchor.service.js';
import { AuditAnchorScheduler } from './audit-anchor.scheduler.js';

function assemble(enabled: boolean) {
  const upsertJobScheduler = vi.fn().mockResolvedValue({ id: 'scheduler-001' });
  const isEnabled = vi.fn().mockReturnValue(enabled);
  return {
    scheduler: new AuditAnchorScheduler(
      { upsertJobScheduler } as unknown as Queue<Record<string, never>, number, string>,
      { isEnabled } as unknown as AuditAnchorService,
    ),
    isEnabled,
    upsertJobScheduler,
  };
}

describe('AuditAnchorScheduler', () => {
  it('WORM 启用时幂等注册固定六小时、失败可观测的调度定义', async () => {
    const { scheduler, isEnabled, upsertJobScheduler } = assemble(true);

    await scheduler.onApplicationBootstrap();

    expect(isEnabled).toHaveBeenCalledOnce();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'audit-maintenance:anchor-pending',
      { every: 21_600_000 },
      {
        name: 'anchor-pending',
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

  it('WORM 未启用时不注册空转任务', async () => {
    const { scheduler, upsertJobScheduler } = assemble(false);

    await scheduler.onApplicationBootstrap();

    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('配置损坏或调度注册失败时失败关闭', async () => {
    const configError = new Error('AUDIT_WORM_CONFIG_INVALID');
    const invalidQueue = { upsertJobScheduler: vi.fn() };
    const invalid = new AuditAnchorScheduler(
      invalidQueue as unknown as Queue<Record<string, never>, number, string>,
      { isEnabled: vi.fn(() => { throw configError; }) } as unknown as AuditAnchorService,
    );
    await expect(invalid.onApplicationBootstrap()).rejects.toBe(configError);
    expect(invalidQueue.upsertJobScheduler).not.toHaveBeenCalled();

    const queueError = new Error('REDIS_UNAVAILABLE');
    const upsertJobScheduler = vi.fn().mockRejectedValue(queueError);
    const unavailable = new AuditAnchorScheduler(
      { upsertJobScheduler } as unknown as Queue<Record<string, never>, number, string>,
      { isEnabled: vi.fn().mockReturnValue(true) } as unknown as AuditAnchorService,
    );
    await expect(unavailable.onApplicationBootstrap()).rejects.toBe(queueError);
  });
});
