import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { CareExecutionQueueService } from './care-execution-queue.service.js';

/** Worker 启动时注册固定空载荷 relay/对账任务。 */
@Injectable()
export class CareAlumniCleanupScheduleBootstrap implements OnApplicationBootstrap {
  constructor(private readonly queue: CareExecutionQueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.ensureAlumniCleanupSchedules();
  }
}
