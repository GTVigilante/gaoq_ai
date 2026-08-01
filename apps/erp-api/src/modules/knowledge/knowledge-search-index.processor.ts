import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { hostname } from 'node:os';
import { z } from 'zod';

import {
  KNOWLEDGE_SEARCH_INDEX_QUEUE,
  KNOWLEDGE_SEARCH_INDEX_SCAN_JOB,
} from './knowledge-search-index.queue.js';
import { KnowledgeSearchIndexRelayService } from './knowledge-search-index-relay.service.js';

/** BullMQ 仅负责周期唤醒；Mongo 索引任务集合是唯一待处理事实源。 */
@Processor(KNOWLEDGE_SEARCH_INDEX_QUEUE, { concurrency: 1 })
export class KnowledgeSearchIndexProcessor extends WorkerHost {
  constructor(private readonly relay: KnowledgeSearchIndexRelayService) {
    super();
  }

  override async process(job: Job): Promise<void> {
    if (job.name !== KNOWLEDGE_SEARCH_INDEX_SCAN_JOB) {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_JOB_UNKNOWN');
    }
    z.object({}).strict().parse(job.data);
    await this.relay.relayBatch(
      `knowledge-search:${hostname()}:${String(job.id ?? 'scan')}`,
    );
  }
}
