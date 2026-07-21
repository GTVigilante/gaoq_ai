import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { CareCaseSummary } from './application/care-application.service.js';
import {
  CARE_EXECUTE_CASE_JOB,
  CARE_EXECUTION_QUEUE,
  type CareExecutionJobData,
} from './care-execution.queue.js';

@Injectable()
export class CareExecutionQueueService {
  constructor(
    private readonly context: TenantContextService,
    @InjectQueue(CARE_EXECUTION_QUEUE) private readonly queue: Queue<CareExecutionJobData>,
  ) {}

  async schedule(careCase: CareCaseSummary): Promise<void> {
    if (careCase.status !== 'scheduled') throw new Error('CARE_QUEUE_CASE_NOT_SCHEDULED');
    const tenantId = this.context.getTenantRequired().tenantId;
    const delay = Math.max(0, Date.parse(careCase.accessDisableAt) - Date.now());
    const jobId = createHash('sha256').update(
      JSON.stringify([tenantId, careCase.id]), 'utf8',
    ).digest('base64url');
    await this.queue.add(
      CARE_EXECUTE_CASE_JOB,
      { tenantId, careCaseId: careCase.id },
      {
        jobId, delay, attempts: 20,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 1_000, removeOnFail: 10_000,
      },
    );
  }
}
