import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MetricsService } from '../observability/metrics.service.js';
import { AuditQueueMetricsPoller } from './audit-queue-metrics.poller.js';

const counts = { waiting: 2, active: 1, delayed: 3, failed: 4 };

function assemble(getJobCounts = vi.fn().mockResolvedValue(counts)) {
  const setQueueJobs = vi.fn();
  const recordQueueMetricsPollFailure = vi.fn();
  const poller = new AuditQueueMetricsPoller(
    { getJobCounts } as unknown as Queue,
    { setQueueJobs, recordQueueMetricsPollFailure } as unknown as MetricsService,
  );
  return { getJobCounts, poller, recordQueueMetricsPollFailure, setQueueJobs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AuditQueueMetricsPoller', () => {
  it('启动时立即采集并以固定低基数队列名周期刷新', async () => {
    const { getJobCounts, poller, setQueueJobs } = assemble();

    await poller.onApplicationBootstrap();
    expect(getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed');
    expect(setQueueJobs).toHaveBeenCalledWith('audit-maintenance', counts);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getJobCounts).toHaveBeenCalledTimes(2);
    expect(setQueueJobs).toHaveBeenCalledTimes(2);

    poller.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJobCounts).toHaveBeenCalledTimes(2);
  });

  it('采集失败只增加固定队列失败指标并继续后续刷新', async () => {
    const getJobCounts = vi.fn()
      .mockRejectedValueOnce(new Error('REDIS_UNAVAILABLE'))
      .mockResolvedValueOnce(counts);
    const {
      poller,
      recordQueueMetricsPollFailure,
      setQueueJobs,
    } = assemble(getJobCounts);

    await poller.onApplicationBootstrap();
    expect(recordQueueMetricsPollFailure).toHaveBeenCalledWith('audit-maintenance');
    expect(setQueueJobs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(setQueueJobs).toHaveBeenCalledWith('audit-maintenance', counts);
    poller.onApplicationShutdown();
  });

  it('前一次刷新未结束时不并发访问 Redis', async () => {
    let resolveSecond: ((value: typeof counts) => void) | undefined;
    const getJobCounts = vi.fn()
      .mockResolvedValueOnce(counts)
      .mockImplementationOnce(() => new Promise<typeof counts>((resolve) => {
        resolveSecond = resolve;
      }));
    const { poller, setQueueJobs } = assemble(getJobCounts);

    await poller.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getJobCounts).toHaveBeenCalledTimes(2);

    resolveSecond?.(counts);
    await Promise.resolve();
    await Promise.resolve();
    expect(setQueueJobs).toHaveBeenCalledTimes(2);
    poller.onApplicationShutdown();
  });

  it('从未启动时关闭保持幂等', () => {
    const { poller } = assemble();
    expect(() => poller.onApplicationShutdown()).not.toThrow();
  });
});
