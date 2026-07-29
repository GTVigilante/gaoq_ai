import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceShiftProcessor } from './attendance-shift.processor.js';
import {
  ATTENDANCE_SHIFT_EVALUATE_JOB,
  ATTENDANCE_SHIFT_SCAN_JOB,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';

const shiftPlanId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';

function job(
  name: string,
  data: unknown,
  id: string | undefined = 'job-001',
): Job<AttendanceShiftJobData> {
  return { name, data, id } as Job<AttendanceShiftJobData>;
}

function assemble() {
  const context = new TenantContextService();
  const shifts = {
    evaluate: vi.fn(() => {
      expect(context.getTenantRequired()).toEqual({
        tenantId: 'tenant-001',
        source: 'service_identity',
      });
      expect(context.getActorRequired()).toMatchObject({
        actorId: 'system:attendance-shift-worker',
        actorType: 'system_job',
        scopes: ['erp:attendance:shift:evaluate'],
        traceId: 'attendance-shift:job-001',
      });
      return Promise.resolve({
        evaluation: { sourceFactId: 'source-fact-001' },
      });
    }),
  };
  const queue = {
    enqueueDue: vi.fn().mockResolvedValue(3),
  };
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const processor = new AttendanceShiftProcessor(
    context,
    shifts as never,
    queue as never,
    audit as never,
  );
  return { processor, shifts, queue, audit };
}

describe('AttendanceShiftProcessor', () => {
  it('扫描任务只接受严格空对象并返回入队数量', async () => {
    const store = assemble();
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_SCAN_JOB,
      {},
    ))).resolves.toBe(3);
    expect(store.queue.enqueueDue).toHaveBeenCalledOnce();
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_SCAN_JOB,
      { tenantId: 'client-controlled' },
    ))).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('拒绝未知任务和非法租户或班次引用', async () => {
    const store = assemble();
    await expect(store.processor.process(job('unknown', {})))
      .rejects.toThrow('ATTENDANCE_SHIFT_JOB_UNKNOWN');
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: '', shiftPlanId },
    ))).rejects.toMatchObject({ name: 'ZodError' });
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: 'tenant-001', shiftPlanId: 'bad' },
    ))).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('在服务身份上下文计算班次并写入最小成功审计', async () => {
    const store = assemble();
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: 'tenant-001', shiftPlanId },
    ))).resolves.toBe(1);
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'attendance.shift.evaluate',
      resourceType: 'attendance_shift_plan',
      resourceId: shiftPlanId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { sourceFactId: 'source-fact-001' },
    });
  });

  it.each([
    [new Error('ATTENDANCE_SOURCE_NOT_READY'), 'ATTENDANCE_SOURCE_NOT_READY'],
    [new Error('lowercase-message'), 'ATTENDANCE_SHIFT_EVALUATION_FAILED'],
    ['non-error', 'ATTENDANCE_SHIFT_EVALUATION_FAILED'],
  ])('计算失败时保留稳定错误码并重抛原错误 %#', async (failure, code) => {
    const store = assemble();
    store.shifts.evaluate.mockRejectedValueOnce(failure);
    await expect(store.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: 'tenant-001', shiftPlanId },
      undefined,
    ))).rejects.toBe(failure);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { failureCode: code },
    }));
  });

  it('审计失败不覆盖已成功业务终态或原业务错误', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const success = assemble();
    success.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(success.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: 'tenant-001', shiftPlanId },
    ))).resolves.toBe(1);

    const failure = assemble();
    const businessError = new Error('ATTENDANCE_SOURCE_NOT_READY');
    failure.shifts.evaluate.mockRejectedValueOnce(businessError);
    failure.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(failure.processor.process(job(
      ATTENDANCE_SHIFT_EVALUATE_JOB,
      { tenantId: 'tenant-001', shiftPlanId },
    ))).rejects.toBe(businessError);
    expect(logError).toHaveBeenCalledTimes(2);
    logError.mockRestore();
  });
});
