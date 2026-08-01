import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { hostname } from 'node:os';
import { z } from 'zod';

import { KnowledgeExamRunRelayService } from './knowledge-exam-run-relay.service.js';
import {
  KNOWLEDGE_EXAM_RUN_QUEUE,
  KNOWLEDGE_EXAM_RUN_SCAN_JOB,
} from './knowledge-exam-run.queue.js';

/** BullMQ 仅周期唤醒；Mongo 考试运行集合是唯一待处理事实源。 */
@Processor(KNOWLEDGE_EXAM_RUN_QUEUE, { concurrency: 1 })
export class KnowledgeExamRunProcessor extends WorkerHost {
  constructor(private readonly relay: KnowledgeExamRunRelayService) { super(); }

  override async process(job: Job): Promise<void> {
    if (job.name !== KNOWLEDGE_EXAM_RUN_SCAN_JOB) {
      throw new Error('KNOWLEDGE_EXAM_RUN_JOB_UNKNOWN');
    }
    z.object({}).strict().parse(job.data);
    await this.relay.relayBatch(`knowledge-exam:${hostname()}:${String(job.id ?? 'scan')}`);
  }
}
