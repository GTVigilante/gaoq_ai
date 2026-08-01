import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../../core/observability/metrics.service.js';
import { QueueMetricsPoller } from '../../core/observability/queue-metrics.poller.js';
import { ORG_INTEGRATION_QUEUE } from './org-integration.queue.js';

@Injectable()
export class OrgQueueMetricsPoller extends QueueMetricsPoller {
  constructor(
    @InjectQueue(ORG_INTEGRATION_QUEUE) queue: Queue,
    metrics: MetricsService,
  ) {
    super(ORG_INTEGRATION_QUEUE, queue, metrics);
  }
}
