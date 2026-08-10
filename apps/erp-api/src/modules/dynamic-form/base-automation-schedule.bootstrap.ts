import { Injectable, type OnModuleInit } from '@nestjs/common';

import { BaseAutomationQueueService } from './base-automation-queue.service.js';

@Injectable()
export class BaseAutomationScheduleBootstrap implements OnModuleInit {
  constructor(private readonly queue: BaseAutomationQueueService) {}
  async onModuleInit(): Promise<void> { await this.queue.ensureRelaySchedule(); }
}
