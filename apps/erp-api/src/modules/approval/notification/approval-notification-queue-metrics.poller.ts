import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../../../core/observability/metrics.service.js';
import { QueueMetricsPoller } from '../../../core/observability/queue-metrics.poller.js';
import { APPROVAL_NOTIFICATION_QUEUE } from './approval-notification.queue.js';

@Injectable()
export class ApprovalNotificationQueueMetricsPoller extends QueueMetricsPoller {
  constructor(
    @InjectQueue(APPROVAL_NOTIFICATION_QUEUE) queue: Queue,
    metrics: MetricsService,
  ) {
    super(APPROVAL_NOTIFICATION_QUEUE, queue, metrics);
  }
}
