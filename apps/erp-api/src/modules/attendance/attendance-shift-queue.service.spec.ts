import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AttendanceShiftQueueService } from './attendance-shift-queue.service.js';
import {
  ATTENDANCE_SHIFT_EVALUATE_JOB,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';
import type { AttendanceShiftPlanDocument } from './persistence/attendance.schemas.js';

describe('AttendanceShiftQueueService', () => {
  it('按到期时间扫描待计算班次并生成稳定任务 ID', async () => {
    const plans = {
      find: vi.fn().mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => ({
              exec: () => Promise.resolve([{
                tenantId: 'tenant-001',
                id: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
                evaluationDueAt: new Date('2026-05-01T08:00:00.000Z'),
              }]),
            }),
          }),
        }),
      }),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue({}),
    };
    const service = new AttendanceShiftQueueService(
      plans as unknown as Model<AttendanceShiftPlanDocument>,
      queue as unknown as Queue<AttendanceShiftJobData>,
    );

    await expect(service.enqueueDue()).resolves.toBe(1);
    const [name, data, options] = queue.add.mock.calls[0] as unknown as [
      string,
      { readonly tenantId: string; readonly shiftPlanId: string },
      { readonly jobId: string; readonly attempts: number },
    ];
    expect(name).toBe(ATTENDANCE_SHIFT_EVALUATE_JOB);
    expect(data).toEqual({
      tenantId: 'tenant-001',
      shiftPlanId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    });
    expect(options.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.attempts).toBe(12);
  });

  it('失败任务只重试一次且不重复新增队列任务', async () => {
    const failed = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const active = {
      getState: vi.fn().mockResolvedValue('active'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const plans = {
      find: vi.fn().mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => ({
              exec: () => Promise.resolve([
                {
                  tenantId: 'tenant-001',
                  id: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
                },
                {
                  tenantId: 'tenant-001',
                  id: '01J8ZQK7V0A2M4N6P8R0T2W4P2',
                },
              ]),
            }),
          }),
        }),
      }),
    };
    const queue = {
      getJob: vi.fn()
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(active),
      add: vi.fn(),
    };
    const service = new AttendanceShiftQueueService(
      plans as never,
      queue as never,
    );

    await expect(service.enqueueDue(10)).resolves.toBe(2);
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(active.retry).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('无到期班次时不访问队列', async () => {
    const limit = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve([]) }),
    });
    const plans = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit }),
      }),
    };
    const queue = {
      getJob: vi.fn(),
      add: vi.fn(),
    };
    const service = new AttendanceShiftQueueService(
      plans as never,
      queue as never,
    );

    await expect(service.enqueueDue(7)).resolves.toBe(0);
    expect(limit).toHaveBeenCalledWith(7);
    expect(queue.getJob).not.toHaveBeenCalled();
  });
});
