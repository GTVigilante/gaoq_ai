import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsCoreModule } from './analytics-core.module.js';

/** 分析 HTTP 外壳；导出任务 Worker 不装配管理查询 Controller。 */
@Module({
  imports: [AnalyticsCoreModule],
  controllers: [AnalyticsController],
  exports: [AnalyticsCoreModule],
})
export class AnalyticsModule {}
