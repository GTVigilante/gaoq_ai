import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MARKETING_OUTBOX_QUEUE } from './marketing-outbox.queue.js';

/** 启动时恢复一分钟周期扫描，队列或进程重启不会丢失数据库中的待投递事实。 */
@Injectable()
export class MarketingOutboxScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MARKETING_OUTBOX_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'scan:marketing-side-effect-outbox',
      { every: 60_000 },
      { name: 'scan:outbox', data: {} },
    );
  }
}
