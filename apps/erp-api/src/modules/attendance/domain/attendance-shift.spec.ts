import { describe, expect, it } from 'vitest';

import { createAttendanceSourceFact } from './attendance.js';
import {
  assertShiftPlanCaptureWindowAvailable,
  createAttendanceShiftPlan,
  evaluateAttendanceShift,
  shiftPlanRequiredThroughDate,
} from './attendance-shift.js';

const createdAt = new Date('2026-04-29T00:00:00.000Z');
const evaluatedAt = new Date('2026-05-02T00:00:00.000Z');

function plan(id = 'shift-plan-001') {
  return createAttendanceShiftPlan({
    id,
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    providerCode: 'workforce_scheduler',
    planCode: 'NIGHT-A',
    businessDate: '2026-04-30',
    rulesetVersion: 'attendance-cn-v2',
    timeZone: 'Asia/Shanghai',
    scheduledStartAt: '2026-04-30T14:00:00.000Z',
    scheduledEndAt: '2026-05-01T06:00:00.000Z',
    breakMinutes: 60,
    graceMinutes: 10,
    earlyArrivalWindowMinutes: 120,
    lateDepartureWindowMinutes: 120,
    sourceObservedAt: '2026-04-29T00:00:00.000Z',
  }, createdAt);
}

function punch(
  id: string,
  factType: 'punch_in' | 'punch_out',
  occurredAt: string,
) {
  return createAttendanceSourceFact({
    id,
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    providerCode: 'feishu',
    factType,
    occurredAt,
    timeZone: 'Asia/Shanghai',
    impact: {
      workedMinutes: 0,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: 0,
    },
    sourceObservedAt: new Date(Date.parse(occurredAt) + 60_000).toISOString(),
  }, evaluatedAt);
}

describe('Attendance 班次规则', () => {
  it('跨日班次归属开始业务日，早到晚退不自动形成加班', () => {
    const shift = plan();
    const result = evaluateAttendanceShift(shift, [
      punch('punch-in-001', 'punch_in', '2026-04-30T13:55:00.000Z'),
      punch('punch-out-001', 'punch_out', '2026-05-01T06:05:00.000Z'),
    ], evaluatedAt);
    expect(result).toMatchObject({
      businessDate: '2026-04-30',
      outcome: 'complete',
      impact: {
        workedMinutes: 900,
        absentMinutes: 0,
        overtimeMinutes: 0,
      },
    });
    expect(shiftPlanRequiredThroughDate(shift)).toBe('2026-05-01');
  });

  it('迟到超过宽限后扣减工时，缺任一打卡时形成整班缺勤', () => {
    const late = evaluateAttendanceShift(plan(), [
      punch('punch-in-late', 'punch_in', '2026-04-30T14:20:00.000Z'),
      punch('punch-out-late', 'punch_out', '2026-05-01T06:00:00.000Z'),
    ], evaluatedAt);
    expect(late.impact).toEqual({
      workedMinutes: 880,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: 20,
    });
    const missing = evaluateAttendanceShift(plan(), [
      punch('punch-in-only', 'punch_in', '2026-04-30T14:00:00.000Z'),
    ], evaluatedAt);
    expect(missing).toMatchObject({
      outcome: 'missing_punch',
      impact: { workedMinutes: 0, absentMinutes: 900 },
    });
  });

  it('捕获窗口重叠时失败关闭，避免同一打卡被两个班次消费', () => {
    const overlapping = createAttendanceShiftPlan({
      ...plan('shift-plan-002'),
      scheduledStartAt: '2026-05-01T05:00:00.000Z',
      scheduledEndAt: '2026-05-01T10:00:00.000Z',
      businessDate: '2026-05-01',
    }, createdAt);
    expect(() => assertShiftPlanCaptureWindowAvailable(overlapping, [plan()]))
      .toThrow('打卡捕获窗口重叠');
  });
});
