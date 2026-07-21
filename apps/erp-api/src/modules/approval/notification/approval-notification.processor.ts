import { randomUUID } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { ApprovalNotificationDeliveryService } from './approval-notification-delivery.service.js';
import {
  APPROVAL_NOTIFICATION_QUEUE,
  type ApprovalNotificationJobName,
} from './approval-notification.queue.js';

/** 双平台通知并行消费；数据库租约负责进程崩溃后的安全恢复。 */
@Processor(APPROVAL_NOTIFICATION_QUEUE, { concurrency: 8, limiter: { max: 20, duration: 1_000 } })
export class ApprovalNotificationProcessor extends WorkerHost {
  private readonly workerId = `approval-notification-${randomUUID()}`;

  constructor(private readonly deliveries: ApprovalNotificationDeliveryService) {
    super();
  }

  override async process(
    job: Job<Record<string, never>, unknown, ApprovalNotificationJobName>,
  ): Promise<number> {
    switch (job.name) {
      case 'deliver:dingtalk':
        return this.deliveries.processBatch('dingtalk', this.workerId, 25);
      case 'deliver:feishu':
        return this.deliveries.processBatch('feishu', this.workerId, 25);
      default:
        throw new Error('未知审批通知任务');
    }
  }
}
