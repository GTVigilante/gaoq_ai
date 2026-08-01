import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  ATTENDANCE_PROVIDER_QUEUE,
  ATTENDANCE_PROVIDER_SCAN_JOB,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';

@Injectable()
export class AttendanceProviderScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ATTENDANCE_PROVIDER_QUEUE)
    private readonly queue: Queue<AttendanceProviderJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'attendance-provider:scan', { every: 60_000 },
      {
        name: ATTENDANCE_PROVIDER_SCAN_JOB, data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1_000 },
      },
    );
  }
}
