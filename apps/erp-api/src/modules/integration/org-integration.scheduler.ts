import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import {
  ORG_INTEGRATION_JOB_NAMES,
  ORG_INTEGRATION_QUEUE,
} from './org-integration.queue.js';

const SCHEDULE_EVERY_MS = 1_000;
const DAILY_EVERY_MS = 24 * 60 * 60 * 1_000;

/** 幂等注册 BullMQ Job Scheduler；多 Worker 同时启动也只保留每类一份调度定义。 */
@Injectable()
export class OrgIntegrationScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ORG_INTEGRATION_QUEUE)
    private readonly queue: Queue<Record<string, never>, unknown, string>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of ORG_INTEGRATION_JOB_NAMES) {
      await this.queue.upsertJobScheduler(
        `org-integration:${name}`,
        { every: name === 'reconcile' ? DAILY_EVERY_MS : SCHEDULE_EVERY_MS },
        {
          name,
          data: {},
          opts: {
            removeOnComplete: 100,
            removeOnFail: 1_000,
            ...(name === 'reconcile'
              ? { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } }
              : {}),
          },
        },
      );
    }
  }
}
