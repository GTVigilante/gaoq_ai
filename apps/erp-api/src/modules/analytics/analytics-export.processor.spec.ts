import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AnalyticsExportService } from './application/analytics-export.service.js';
import { AnalyticsExportProcessor } from './analytics-export.processor.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  createAnalyticsExportJobId,
} from './analytics-export.queue.js';

const data: AnalyticsExportJobData = {
  exportId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
  tenantId: 'tenant-001',
  requestedBy: 'actor-001',
  generation: 1,
};

function job(input: Partial<Job<AnalyticsExportJobData>> = {}): Job<AnalyticsExportJobData> {
  return {
    id: createAnalyticsExportJobId(data),
    name: ANALYTICS_GENERATE_EXPORT_JOB,
    data,
    ...input,
  } as Job<AnalyticsExportJobData>;
}

describe('AnalyticsExportProcessor', () => {
  it('只把名称、严格载荷和确定性 JobId 均匹配的任务交给应用服务', async () => {
    const service = { process: vi.fn().mockResolvedValue(undefined) };
    const processor = new AnalyticsExportProcessor(
      service as unknown as AnalyticsExportService,
    );
    await processor.process(job());
    expect(service.process).toHaveBeenCalledWith(data, createAnalyticsExportJobId(data));
  });

  it('拒绝未知任务名称，不触发任何业务能力', async () => {
    const service = { process: vi.fn() };
    const processor = new AnalyticsExportProcessor(
      service as unknown as AnalyticsExportService,
    );
    await expect(processor.process(job({ name: 'unknown' })))
      .rejects.toThrow('ANALYTICS_EXPORT_JOB_UNKNOWN');
    expect(service.process).not.toHaveBeenCalled();
  });

  it.each([
    { id: undefined },
    { id: 'replayed_job' },
    { data: { ...data, generation: 0 } },
    { data: { ...data, tenantId: '*invalid' } },
    { data: { ...data, unexpected: true } },
  ])('拒绝缺失、重放或越权扩展的任务载荷 %#', async (invalid) => {
    const service = { process: vi.fn() };
    const processor = new AnalyticsExportProcessor(
      service as unknown as AnalyticsExportService,
    );
    await expect(processor.process(job(invalid as Partial<Job<AnalyticsExportJobData>>)))
      .rejects.toThrow('ANALYTICS_EXPORT_JOB_INVALID');
    expect(service.process).not.toHaveBeenCalled();
  });
});
