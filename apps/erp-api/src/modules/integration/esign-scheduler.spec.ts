import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { ESignScheduler } from './esign-scheduler.js';
import type { ESignQueueJobData } from './esign-webhook.queue.js';

describe('ESignScheduler', () => {
  it('每 15 分钟幂等注册流程补拉', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue({ id: 'scheduler-001' });
    const scheduler = new ESignScheduler({ upsertJobScheduler } as unknown as Queue<ESignQueueJobData>);
    await scheduler.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'esign:reconcile-flows', { every: 900_000 },
      expect.objectContaining({ name: 'reconcile:esign:flows', data: {} }),
    );
  });
});
