import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CareExecutionQueueService } from './care-execution-queue.service.js';

/** Worker 启动时确保空载荷关怀对账任务存在。 */
@Injectable()
export class CareOccasionScheduleBootstrap implements OnModuleInit {
  constructor(private readonly queue: CareExecutionQueueService) {}

  async onModuleInit(): Promise<void> {
    await this.queue.ensureOccasionReconcileSchedule();
  }
}
