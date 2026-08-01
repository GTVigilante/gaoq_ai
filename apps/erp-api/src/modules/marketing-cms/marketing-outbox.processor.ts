import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { hostname } from 'node:os';
import { MARKETING_OUTBOX_QUEUE } from './marketing-outbox.queue.js';
import { MarketingOutboxRelayService } from './marketing-outbox-relay.service.js';

/** 周期扫描营销 Outbox；队列任务只负责唤醒，MongoDB 是唯一待投递事实源。 */
@Processor(MARKETING_OUTBOX_QUEUE, { concurrency: 1 })
export class MarketingOutboxProcessor extends WorkerHost {
  constructor(private readonly relay: MarketingOutboxRelayService) {
    super();
  }

  override async process(job: Job): Promise<void> {
    await this.relay.relayBatch(`marketing-outbox:${hostname()}:${String(job.id ?? 'scan')}`);
  }
}
