import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../observability/metrics.service.js';
import { QueueMetricsPoller } from '../observability/queue-metrics.poller.js';
import { AUDIT_MAINTENANCE_QUEUE } from './audit-maintenance.queue.js';

@Injectable()
export class AuditQueueMetricsPoller extends QueueMetricsPoller {
  constructor(
    @InjectQueue(AUDIT_MAINTENANCE_QUEUE) queue: Queue,
    metrics: MetricsService,
  ) {
    super(AUDIT_MAINTENANCE_QUEUE, queue, metrics);
  }
}
