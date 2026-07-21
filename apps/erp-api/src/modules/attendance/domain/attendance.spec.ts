import { describe, expect, it } from 'vitest';

import {
  AttendanceDomainError,
  businessDateAt,
  closeAttendanceMonth,
  createAttendanceCorrection,
  createAttendanceSourceFact,
} from './attendance.js';

const now = new Date('2026-04-02T00:00:00.000Z');
const impact = {
  workedMinutes: 480,
  leaveMinutes: 0,
  overtimeMinutes: 60,
  absentMinutes: 0,
};

function fact(id = 'fact-001') {
  return createAttendanceSourceFact({
    id,
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    providerCode: 'dingtalk',
    factType: 'shift',
    occurredAt: '2026-03-31T16:30:00.000Z',
    timeZone: 'Asia/Shanghai',
    impact,
    sourceObservedAt: '2026-03-31T16:31:00.000Z',
  }, now);
}

describe('Attendance 领域', () => {
  it('按显式业务时区计算日期，不受服务器时区影响', () => {
    expect(businessDateAt('2026-03-31T16:30:00.000Z', 'Asia/Shanghai')).toBe('2026-04-01');
    expect(businessDateAt('2026-03-31T16:30:00.000Z', 'America/New_York')).toBe('2026-03-31');
  });

  it('审批修订替换源事实影响但不修改源事实，并生成确定性快照', () => {
    const source = fact();
    const correction = createAttendanceCorrection({
      id: 'correction-001',
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      sourceFactId: source.id,
      businessDate: source.businessDate,
      replacementImpact: { ...impact, workedMinutes: 420, overtimeMinutes: 0 },
      reasonCode: 'MISSED_BREAK',
      approvalInstanceId: 'approval-001',
      approvalEvidenceId: 'evidence-001',
      approvedAt: '2026-04-01T12:00:00.000Z',
    }, now);
    const input = {
      id: 'snapshot-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 1, rulesetVersion: 'attendance-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [source], corrections: [correction],
      previousSnapshotId: null, supersessionEvidenceId: null,
    } as const;
    const first = closeAttendanceMonth(input, now);
    const second = closeAttendanceMonth(input, now);
    expect(first.workedMinutes).toBe(420);
    expect(first.correctionCount).toBe(1);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(source.impact.workedMinutes).toBe(480);
  });

  it('重开月结缺少前序引用或审批证据时失败关闭', () => {
    expect(() => closeAttendanceMonth({
      id: 'snapshot-002', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 2, rulesetVersion: 'attendance-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [fact()], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
    }, now)).toThrowError(new AttendanceDomainError(
      'ATTENDANCE_SUPERSESSION_EVIDENCE_REQUIRED', '重开月结必须引用前序快照和审批证据',
    ));
  });

  it('拒绝跨月事实和同一事实多个生效修订', () => {
    const source = fact();
    expect(() => closeAttendanceMonth({
      id: 'snapshot-003', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-03', snapshotVersion: 1, rulesetVersion: 'attendance-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [source], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
    }, now)).toThrowError(/不属于当前租户、员工或月份/);
  });
});
