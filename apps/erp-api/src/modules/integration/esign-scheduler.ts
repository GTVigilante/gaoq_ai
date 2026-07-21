import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  ESIGN_RECONCILE_FLOWS_JOB,
  ESIGN_WEBHOOK_QUEUE,
  type ESignQueueJobData,
} from './esign-webhook.queue.js';

const RECONCILE_EVERY_MS = 15 * 60 * 1_000;

/** 幂等注册 eSign 补拉调度，多 Worker 也只保留一份定义。 */
@Injectable()
export class ESignScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ESIGN_WEBHOOK_QUEUE)
    private readonly queue: Queue<ESignQueueJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'esign:reconcile-flows',
      { every: RECONCILE_EVERY_MS },
      {
        name: ESIGN_RECONCILE_FLOWS_JOB,
        data: {},
        opts: {
          attempts: 3, backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100, removeOnFail: 1_000,
        },
      },
    );
  }
}
