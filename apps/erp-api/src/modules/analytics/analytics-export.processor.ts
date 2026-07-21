import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { AnalyticsExportService } from './application/analytics-export.service.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  ANALYTICS_EXPORT_QUEUE,
} from './analytics-export.queue.js';

/** 独立 Worker 生成固定聚合导出，API 进程不执行重任务。 */
@Processor(ANALYTICS_EXPORT_QUEUE, { concurrency: 2, limiter: { max: 10, duration: 1_000 } })
export class AnalyticsExportProcessor extends WorkerHost {
  constructor(private readonly exports: AnalyticsExportService) { super(); }

  async process(job: Job<AnalyticsExportJobData>): Promise<void> {
    if (job.name !== ANALYTICS_GENERATE_EXPORT_JOB) throw new Error('ANALYTICS_EXPORT_JOB_UNKNOWN');
    await this.exports.process(job.data);
  }
}
