import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MARKETING_AUTOMATION_QUEUE } from './marketing-automation.queue.js';

/** 每分钟修复可能因 API/Redis 短暂故障而遗漏的到期发布任务。 */
@Injectable()
export class MarketingPublishScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MARKETING_AUTOMATION_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'scan:scheduled-marketing-content',
      { every: 60_000 },
      { name: 'scan:scheduled', data: {} },
    );
  }
}
