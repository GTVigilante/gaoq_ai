import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { MetricsService } from '../../../core/observability/metrics.service.js';
import { APPROVAL_NOTIFICATION_QUEUE } from './approval-notification.queue.js';
import { ApprovalNotificationQueueMetricsPoller } from './approval-notification-queue-metrics.poller.js';

describe('ApprovalNotificationQueueMetricsPoller', () => {
  it('使用固定队列名采集队列指标并可安全关闭', async () => {
    const getJobCounts = vi.fn().mockResolvedValue({
      waiting: 1, active: 2, delayed: 3, failed: 4,
    });
    const setQueueJobs = vi.fn();
    const poller = new ApprovalNotificationQueueMetricsPoller(
      { getJobCounts } as unknown as Queue,
      {
        setQueueJobs,
        recordQueueMetricsPollFailure: vi.fn(),
      } as unknown as MetricsService,
    );
    await poller.onApplicationBootstrap();
    expect(getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed');
    expect(setQueueJobs).toHaveBeenCalledWith(APPROVAL_NOTIFICATION_QUEUE, {
      waiting: 1, active: 2, delayed: 3, failed: 4,
    });
    poller.onApplicationShutdown();
  });
});
