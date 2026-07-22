import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import {
  DATA_MIGRATION_ATTACHMENT_QUEUE,
  DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB,
  type DataMigrationAttachmentJobData,
} from './data-migration-attachment.queue.js';

@Processor(DATA_MIGRATION_ATTACHMENT_QUEUE, {
  concurrency: 2, limiter: { max: 10, duration: 1_000 },
})
export class DataMigrationAttachmentProcessor extends WorkerHost {
  constructor(private readonly attachments: DataMigrationAttachmentService) { super(); }

  async process(job: Job<DataMigrationAttachmentJobData>): Promise<void> {
    if (job.name !== DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_JOB_UNKNOWN');
    }
    await this.attachments.process(job.data);
  }
}
