import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  APPROVAL_NOTIFICATION_JOB_NAMES,
  APPROVAL_NOTIFICATION_QUEUE,
} from './approval-notification.queue.js';

/** 多 Worker 幂等注册固定频率调度器。 */
@Injectable()
export class ApprovalNotificationScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(APPROVAL_NOTIFICATION_QUEUE)
    private readonly queue: Queue<Record<string, never>, unknown, string>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of APPROVAL_NOTIFICATION_JOB_NAMES) {
      await this.queue.upsertJobScheduler(
        `approval-notification:${name}`,
        { every: 1_000 },
        {
          name,
          data: {},
          opts: { removeOnComplete: 100, removeOnFail: 1_000 },
        },
      );
    }
  }
}
