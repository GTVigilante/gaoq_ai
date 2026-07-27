import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  KNOWLEDGE_EXAM_RUN_QUEUE,
  KNOWLEDGE_EXAM_RUN_SCAN_JOB,
} from './knowledge-exam-run.queue.js';

@Injectable()
export class KnowledgeExamRunScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(KNOWLEDGE_EXAM_RUN_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'scan:knowledge-exam-runs',
      { every: 15_000 },
      { name: KNOWLEDGE_EXAM_RUN_SCAN_JOB, data: {} },
    );
  }
}
