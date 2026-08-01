import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  ATTENDANCE_SHIFT_QUEUE,
  ATTENDANCE_SHIFT_SCAN_JOB,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';

@Injectable()
export class AttendanceShiftScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ATTENDANCE_SHIFT_QUEUE)
    private readonly queue: Queue<AttendanceShiftJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'attendance-shift:scan',
      { every: 60_000 },
      {
        name: ATTENDANCE_SHIFT_SCAN_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1_000 },
      },
    );
  }
}
