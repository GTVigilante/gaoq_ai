import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { AuditAnchorService } from './audit-anchor.service.js';
import { AUDIT_ANCHOR_JOB, AUDIT_MAINTENANCE_QUEUE } from './audit-maintenance.queue.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

/** 幂等注册审计锚定调度；未配置外部 WORM 的非生产环境不创建空转任务。 */
@Injectable()
export class AuditAnchorScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(AUDIT_MAINTENANCE_QUEUE)
    private readonly queue: Queue<Record<string, never>, number, string>,
    private readonly anchors: AuditAnchorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.anchors.isEnabled()) return;
    await this.queue.upsertJobScheduler(
      'audit-maintenance:anchor-pending',
      { every: SIX_HOURS_MS },
      {
        name: AUDIT_ANCHOR_JOB,
        data: {},
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 1_000,
        },
      },
    );
  }
}
