import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ApprovalNotificationInfrastructureModule } from './approval-notification-infrastructure.module.js';
import { ApprovalNotificationProcessor } from './approval-notification.processor.js';
import { APPROVAL_NOTIFICATION_QUEUE } from './approval-notification.queue.js';
import { ApprovalNotificationQueueMetricsPoller } from './approval-notification-queue-metrics.poller.js';
import { ApprovalNotificationScheduler } from './approval-notification.scheduler.js';

/** 只在独立 Worker 进程装配审批通知消费者，API 进程不执行平台网络调用。 */
@Module({
  imports: [
    ApprovalNotificationInfrastructureModule,
    BullModule.registerQueue({ name: APPROVAL_NOTIFICATION_QUEUE }),
  ],
  providers: [
    ApprovalNotificationProcessor,
    ApprovalNotificationScheduler,
    ApprovalNotificationQueueMetricsPoller,
  ],
})
export class ApprovalNotificationWorkerModule {}
