import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { IntegrationModule } from './integration.module.js';
import { ESignWebhookProcessor } from './esign-webhook.processor.js';
import { ESignScheduler } from './esign-scheduler.js';
import { ESignQueueMetricsPoller } from './esign-queue-metrics.poller.js';
import { ESIGN_WEBHOOK_QUEUE } from './esign-webhook.queue.js';
import { ORG_INTEGRATION_QUEUE } from './org-integration.queue.js';
import { OrgIntegrationProcessor } from './org-integration.processor.js';
import { OrgIntegrationScheduler } from './org-integration.scheduler.js';
import { OrgQueueMetricsPoller } from './org-queue-metrics.poller.js';
import { RecruitmentChannelProcessor } from './recruitment-channel.processor.js';
import { RECRUITMENT_CHANNEL_QUEUE } from './recruitment-channel.queue.js';
import { RecruitmentChannelScheduler } from './recruitment-channel.scheduler.js';
import { AttendanceProviderProcessor } from './attendance-provider.processor.js';
import { ATTENDANCE_PROVIDER_QUEUE } from './attendance-provider.queue.js';
import { AttendanceProviderScheduler } from './attendance-provider.scheduler.js';
import { OpModule } from '../op/op.module.js';
import { OpOperatingSummaryProcessor } from '../op/op-operating-summary.processor.js';
import { OP_OPERATING_SUMMARY_QUEUE } from '../op/op-operating-summary.queue.js';
import { OpApprovalProcessor } from '../op/op-approval.processor.js';
import { OP_APPROVAL_BRIDGE_QUEUE } from '../op/op-approval.queue.js';
import { OpApprovalScheduler } from '../op/op-approval.scheduler.js';
import { OpApprovalQueueMetricsPoller } from '../op/op-approval-queue-metrics.poller.js';

/** 只在独立 Worker 进程装配队列消费者，API 进程不消费后台任务。 */
@Module({
  imports: [
    IntegrationModule,
    BullModule.registerQueue({ name: ORG_INTEGRATION_QUEUE }),
    BullModule.registerQueue({ name: ESIGN_WEBHOOK_QUEUE }),
    BullModule.registerQueue({ name: RECRUITMENT_CHANNEL_QUEUE }),
    BullModule.registerQueue({ name: ATTENDANCE_PROVIDER_QUEUE }),
    BullModule.registerQueue({ name: OP_OPERATING_SUMMARY_QUEUE }),
    BullModule.registerQueue({ name: OP_APPROVAL_BRIDGE_QUEUE }),
    OpModule,
  ],
  providers: [
    OrgIntegrationProcessor, OrgIntegrationScheduler, OrgQueueMetricsPoller,
    ESignWebhookProcessor, ESignScheduler, ESignQueueMetricsPoller,
    RecruitmentChannelProcessor, RecruitmentChannelScheduler,
    AttendanceProviderProcessor, AttendanceProviderScheduler,
    OpOperatingSummaryProcessor,
    OpApprovalProcessor, OpApprovalScheduler, OpApprovalQueueMetricsPoller,
  ],
})
export class IntegrationWorkerModule {}
