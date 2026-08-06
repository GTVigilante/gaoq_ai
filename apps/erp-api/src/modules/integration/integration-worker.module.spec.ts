import { getQueueToken } from '@nestjs/bullmq';
import { describe, expect, it } from 'vitest';

import { ATTENDANCE_SHIFT_QUEUE } from '../attendance/attendance-shift.queue.js';
import { AttendanceShiftScheduler } from '../attendance/attendance-shift.scheduler.js';
import { IntegrationWorkerModule } from './integration-worker.module.js';

const MODULE_IMPORTS = 'imports';
const MODULE_PROVIDERS = 'providers';

describe('IntegrationWorkerModule', () => {
  it('为考勤班次调度器装配其消费的队列', () => {
    const imports = Reflect.getMetadata(MODULE_IMPORTS, IntegrationWorkerModule) as Array<{
      readonly exports?: readonly unknown[];
    }>;
    expect(imports).toContainEqual(expect.objectContaining({
      exports: [expect.objectContaining({ provide: getQueueToken(ATTENDANCE_SHIFT_QUEUE) })],
    }));
  });

  it('考勤班次调度器只装配在独立 Worker 模块', () => {
    const providers = Reflect.getMetadata(MODULE_PROVIDERS, IntegrationWorkerModule) as unknown[];
    expect(providers).toContain(AttendanceShiftScheduler);
  });
});
