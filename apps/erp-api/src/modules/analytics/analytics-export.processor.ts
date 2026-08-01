import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { AnalyticsExportService } from './application/analytics-export.service.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  ANALYTICS_EXPORT_QUEUE,
  createAnalyticsExportJobId,
} from './analytics-export.queue.js';

const jobDataSchema = z.object({
  exportId: z.string().regex(ULID_PATTERN),
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  requestedBy: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  generation: z.number().int().positive(),
}).strict();

/** 独立 Worker 生成固定聚合导出，API 进程不执行重任务。 */
@Processor(ANALYTICS_EXPORT_QUEUE, { concurrency: 2, limiter: { max: 10, duration: 1_000 } })
export class AnalyticsExportProcessor extends WorkerHost {
  constructor(private readonly exports: AnalyticsExportService) { super(); }

  override async process(job: Job<AnalyticsExportJobData>): Promise<void> {
    if (job.name !== ANALYTICS_GENERATE_EXPORT_JOB) throw new Error('ANALYTICS_EXPORT_JOB_UNKNOWN');
    const parsed = jobDataSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id === undefined ||
      job.id !== createAnalyticsExportJobId(parsed.data)
    ) {
      throw new Error('ANALYTICS_EXPORT_JOB_INVALID');
    }
    await this.exports.process(parsed.data, job.id);
  }
}
