import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditAnchorProcessor } from './audit-anchor.processor.js';
import { AuditAnchorScheduler } from './audit-anchor.scheduler.js';
import { AuditQueueMetricsPoller } from './audit-queue-metrics.poller.js';
import { AUDIT_MAINTENANCE_QUEUE } from './audit-maintenance.queue.js';
import { AuditModule } from './audit.module.js';

/** 独立 Worker 中装配审计锚定队列，API 进程不执行后台导出。 */
@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: AUDIT_MAINTENANCE_QUEUE })],
  providers: [AuditAnchorProcessor, AuditAnchorScheduler, AuditQueueMetricsPoller],
})
export class AuditWorkerModule {}
