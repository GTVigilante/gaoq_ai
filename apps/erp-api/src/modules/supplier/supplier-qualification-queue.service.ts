import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  SUPPLIER_QUALIFICATION_QUEUE,
  SUPPLIER_QUALIFICATION_SCAN_JOB,
  type SupplierQualificationScanJobData,
} from './supplier-qualification.queue.js';

@Injectable()
export class SupplierQualificationQueueService {
  constructor(
    @InjectQueue(SUPPLIER_QUALIFICATION_QUEUE)
    private readonly queue: Queue<SupplierQualificationScanJobData>,
  ) {}

  async ensureSchedule(): Promise<void> {
    await this.queue.add(SUPPLIER_QUALIFICATION_SCAN_JOB, {}, {
      jobId: 'supplier-qualification-scan-v1',
      repeat: { pattern: '0 15 1 * * *' },
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 30,
      removeOnFail: 100,
    });
  }
}
