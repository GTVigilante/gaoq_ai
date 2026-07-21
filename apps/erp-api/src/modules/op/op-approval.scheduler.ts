import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  OP_APPROVAL_BRIDGE_QUEUE,
  OP_DELIVER_APPROVAL_RESULT_JOB,
  OP_RELAY_APPROVAL_RESULT_JOB,
  type OpApprovalBridgeJobData,
} from './op-approval.queue.js';

/** 幂等注册 OP 审批 Outbox relay 与结果投递调度。 */
@Injectable()
export class OpApprovalScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(OP_APPROVAL_BRIDGE_QUEUE)
    private readonly queue: Queue<OpApprovalBridgeJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of [OP_RELAY_APPROVAL_RESULT_JOB, OP_DELIVER_APPROVAL_RESULT_JOB] as const) {
      await this.queue.upsertJobScheduler(
        `op-approval:${name}`,
        { every: 1_000 },
        { name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 1_000 } },
      );
    }
  }
}
