import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  KNOWLEDGE_SEARCH_INDEX_QUEUE,
  KNOWLEDGE_SEARCH_INDEX_SCAN_JOB,
} from './knowledge-search-index.queue.js';

/** 多 Worker 幂等注册周期任务，重启后继续扫描数据库中的未完成索引任务。 */
@Injectable()
export class KnowledgeSearchIndexScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(KNOWLEDGE_SEARCH_INDEX_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'scan:knowledge-search-index',
      { every: 60_000 },
      { name: KNOWLEDGE_SEARCH_INDEX_SCAN_JOB, data: {} },
    );
  }
}
