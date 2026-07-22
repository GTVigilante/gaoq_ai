import { describe, expect, it } from 'vitest';

import {
  AttendanceDomainError,
  businessDateAt,
  closeAttendanceMonth,
  createAttendanceCorrection,
  createAttendanceSourceFact,
  restoreAttendanceSourceFactFromMigration,
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
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
      approvalReferenceType: 'approval_instance', approvalInstanceId: 'approval-001',
      approvalHistoryId: null,
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

  it('迁移源事实保留严格历史时间并拒绝未来或倒置时间线', () => {
    const restored = restoreAttendanceSourceFactFromMigration({
      id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'legacy_hr', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai', impact,
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }, now);
    expect(restored).toMatchObject({
      businessDate: '2026-04-01', createdAt: '2026-04-01T01:02:00.000Z',
    });
    expect(() => restoreAttendanceSourceFactFromMigration({
      ...restored, sourceObservedAt: '2026-04-01T00:59:00.000Z',
    }, now)).toThrow('时间线');
    expect(() => restoreAttendanceSourceFactFromMigration({
      ...restored, createdAt: '2026-04-02T00:06:00.000Z',
    }, now)).toThrow('时间线');
  });

  it('迁移修订保留审批与落库时间并拒绝先落库后批准', () => {
    const restored = restoreAttendanceCorrectionFromMigration({
      id: 'correction-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      sourceFactId: 'fact-legacy-001', businessDate: '2026-04-01',
      replacementImpact: impact, reasonCode: 'LEGACY_APPROVED',
      approvalReferenceType: 'legacy_history', approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001',
      approvalEvidenceId: 'approval-history-001',
      approvedAt: '2026-04-01T02:00:00.000Z',
      createdAt: '2026-04-01T02:01:00.000Z',
    }, now);
    expect(restored.createdAt).toBe('2026-04-01T02:01:00.000Z');
    expect(() => restoreAttendanceCorrectionFromMigration({
      ...restored, approvedAt: '2026-04-01T02:02:00.000Z',
    }, now)).toThrow('时间线');
  });

  it('迁移月结复用领域重算并保留历史关账时间', () => {
    const restored = restoreAttendanceMonthFromMigration({
      id: 'snapshot-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 1, rulesetVersion: 'legacy-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [fact()], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
      closedAt: '2026-04-02T00:01:00.000Z',
    }, new Date('2026-04-03T00:00:00.000Z'));
    expect(restored).toMatchObject({
      workedMinutes: 480, sourceFactCount: 1, snapshotVersion: 1,
      closedAt: '2026-04-02T00:01:00.000Z',
    });
  });
});
