import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../../core/observability/metrics.service.js';
import { QueueMetricsPoller } from '../../core/observability/queue-metrics.poller.js';
import { ESIGN_WEBHOOK_QUEUE } from './esign-webhook.queue.js';

/** 暴露 eSign 回调、补拉与证据归档共享队列的深度和失败数。 */
@Injectable()
export class ESignQueueMetricsPoller extends QueueMetricsPoller {
  constructor(
    @InjectQueue(ESIGN_WEBHOOK_QUEUE) queue: Queue,
    metrics: MetricsService,
  ) {
    super(ESIGN_WEBHOOK_QUEUE, queue, metrics);
  }
}
