import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { AuditAnchorService } from './audit-anchor.service.js';
import { AUDIT_ANCHOR_JOB, AUDIT_MAINTENANCE_QUEUE } from './audit-maintenance.queue.js';

/** 单并发导出外部 WORM 锚点，幂等键保证 Worker 崩溃重试不会产生不同对象。 */
@Processor(AUDIT_MAINTENANCE_QUEUE, { concurrency: 1 })
export class AuditAnchorProcessor extends WorkerHost {
  constructor(private readonly anchors: AuditAnchorService) {
    super();
  }

  override async process(job: Job<Record<string, never>, number, typeof AUDIT_ANCHOR_JOB>): Promise<number> {
    if (job.name !== AUDIT_ANCHOR_JOB) {
      throw new Error('AUDIT_MAINTENANCE_JOB_INVALID');
    }
    return this.anchors.anchorPendingTenants(100);
  }
}
