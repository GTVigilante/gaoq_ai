import { randomUUID } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import {
  OP_APPROVAL_BRIDGE_QUEUE,
  OP_DELIVER_APPROVAL_RESULT_JOB,
  OP_PROCESS_APPROVAL_REQUEST_JOB,
  OP_RELAY_APPROVAL_RESULT_JOB,
  type OpApprovalBridgeJobData,
  type OpApprovalBridgeJobName,
} from './op-approval.queue.js';
import { OpApprovalRequestService } from './op-approval-request.service.js';
import { OpApprovalResultDeliveryService } from './op-approval-result-delivery.service.js';
import { OpApprovalResultRelayService } from './op-approval-result-relay.service.js';

/** OP 审批桥 Worker：请求、Outbox relay 与结果投递分作独立任务。 */
@Processor(OP_APPROVAL_BRIDGE_QUEUE, { concurrency: 6, limiter: { max: 30, duration: 1_000 } })
export class OpApprovalProcessor extends WorkerHost {
  private readonly workerId = `op-approval-${randomUUID()}`;

  constructor(
    private readonly requests: OpApprovalRequestService,
    private readonly relay: OpApprovalResultRelayService,
    private readonly deliveries: OpApprovalResultDeliveryService,
  ) {
    super();
  }

  override async process(
    job: Job<OpApprovalBridgeJobData, unknown, OpApprovalBridgeJobName>,
  ): Promise<number> {
    switch (job.name) {
      case OP_PROCESS_APPROVAL_REQUEST_JOB:
        return this.requests.process(job.data);
      case OP_RELAY_APPROVAL_RESULT_JOB:
        return this.relay.relayBatch(this.workerId, 50);
      case OP_DELIVER_APPROVAL_RESULT_JOB:
        return this.deliveries.processBatch(this.workerId, 25);
      default:
        throw new Error('OP_APPROVAL_JOB_UNKNOWN');
    }
  }
}
