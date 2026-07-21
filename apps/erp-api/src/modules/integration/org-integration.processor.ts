import { randomUUID } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { OrgDeliveryService } from './org-delivery.service.js';
import {
  ORG_INTEGRATION_QUEUE,
  type OrgIntegrationJobName,
} from './org-integration.queue.js';
import { OrgOutboxRelayService } from './org-outbox-relay.service.js';
import { OrgReconciliationService } from './org-reconciliation.service.js';

/** 组织集成 Worker：relay 与双平台投递相互独立，服务内部租约负责崩溃恢复。 */
@Processor(ORG_INTEGRATION_QUEUE, { concurrency: 6, limiter: { max: 30, duration: 1_000 } })
export class OrgIntegrationProcessor extends WorkerHost {
  private readonly workerId = `org-worker-${randomUUID()}`;

  constructor(
    private readonly relay: OrgOutboxRelayService,
    private readonly deliveries: OrgDeliveryService,
    private readonly reconciliation: OrgReconciliationService,
  ) {
    super();
  }

  override async process(
    job: Job<Record<string, never>, unknown, OrgIntegrationJobName>,
  ): Promise<number> {
    switch (job.name) {
      case 'relay':
        return this.relay.relayBatch(this.workerId, 50);
      case 'deliver:dingtalk':
        return this.deliveries.processBatch('dingtalk', this.workerId, 25);
      case 'deliver:feishu':
        return this.deliveries.processBatch('feishu', this.workerId, 25);
      case 'reconcile':
        return this.reconciliation.runDaily();
      default:
        throw new Error('未知组织集成任务');
    }
  }
}
