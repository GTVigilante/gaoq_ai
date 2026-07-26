import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AttendanceController } from './attendance.controller.js';

describe('AttendanceController', () => {
  it('业务已提交后审计不可用不应把成功响应改写为失败', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const result = {
      shiftPlan: {
        id: 'shift-plan-001',
        employeeId: 'employee-001',
        planCode: 'DAY-A',
        businessDate: '2026-04-01',
        rulesetVersion: 'attendance-cn-v2',
      },
    };
    const shifts = { assign: vi.fn().mockResolvedValue(result) };
    const audit = { record: vi.fn().mockRejectedValue(new Error('AUDIT_STORAGE_UNAVAILABLE')) };
    const controller = new AttendanceController(
      {} as never,
      shifts as never,
      audit as never,
    );
    await expect(controller.assignShiftPlan('idempotency-key-001', {} as never))
      .resolves.toEqual(result);
    expect(shifts.assign).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ATTENDANCE_AUDIT_WRITE_FAILED',
      failureCode: 'AUDIT_STORAGE_UNAVAILABLE',
    }));
    log.mockRestore();
  });
});
