import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../../core/observability/metrics.service.js';
import { QueueMetricsPoller } from '../../core/observability/queue-metrics.poller.js';
import { OP_APPROVAL_BRIDGE_QUEUE } from './op-approval.queue.js';

/** OP 审批桥低基数队列指标，不使用租户、事件或单据标识作为标签。 */
@Injectable()
export class OpApprovalQueueMetricsPoller extends QueueMetricsPoller {
  constructor(
    @InjectQueue(OP_APPROVAL_BRIDGE_QUEUE) queue: Queue,
    metrics: MetricsService,
  ) {
    super(OP_APPROVAL_BRIDGE_QUEUE, queue, metrics);
  }
}
