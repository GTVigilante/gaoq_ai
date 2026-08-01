import { type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { MetricsService } from './metrics.service.js';

const POLL_INTERVAL_MS = 15_000;

/** 单队列低频采集器；队列名由模块常量注入，禁止使用任务 ID 作为标签。 */
export abstract class QueueMetricsPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  protected constructor(
    private readonly queueName: string,
    private readonly queue: Queue,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      this.metrics.setQueueJobs(this.queueName, counts);
    } catch {
      this.metrics.recordQueueMetricsPollFailure(this.queueName);
    } finally {
      this.refreshing = false;
    }
  }
}
