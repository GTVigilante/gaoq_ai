import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { IntegrationModule } from './integration.module.js';
import { ORG_INTEGRATION_QUEUE } from './org-integration.queue.js';
import { OrgIntegrationProcessor } from './org-integration.processor.js';
import { OrgIntegrationScheduler } from './org-integration.scheduler.js';
import { OrgQueueMetricsPoller } from './org-queue-metrics.poller.js';

/** 只在独立 Worker 进程装配队列消费者，API 进程不消费后台任务。 */
@Module({
  imports: [
    IntegrationModule,
    BullModule.registerQueue({ name: ORG_INTEGRATION_QUEUE }),
  ],
  providers: [OrgIntegrationProcessor, OrgIntegrationScheduler, OrgQueueMetricsPoller],
})
export class IntegrationWorkerModule {}
