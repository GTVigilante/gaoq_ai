import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AnalyticsExportProcessor } from './analytics-export.processor.js';
import { ANALYTICS_EXPORT_QUEUE } from './analytics-export.queue.js';
import { AnalyticsModule } from './analytics.module.js';

/** 管理分析 Worker 装配；仅在独立 Worker 根模块加载。 */
@Module({
  imports: [AnalyticsModule, BullModule.registerQueue({ name: ANALYTICS_EXPORT_QUEUE })],
  providers: [AnalyticsExportProcessor],
})
export class AnalyticsWorkerModule {}
