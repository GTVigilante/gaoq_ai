import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { AttendanceShiftScheduler } from './attendance-shift.scheduler.js';
import {
  ATTENDANCE_SHIFT_SCAN_JOB,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';

describe('AttendanceShiftScheduler', () => {
  it('启动时幂等注册每分钟扫描计划并限制任务留存', async () => {
    const queue = {
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    };
    const scheduler = new AttendanceShiftScheduler(
      queue as unknown as Queue<AttendanceShiftJobData>,
    );

    await expect(scheduler.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'attendance-shift:scan',
      { every: 60_000 },
      {
        name: ATTENDANCE_SHIFT_SCAN_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1_000 },
      },
    );
  });
});
