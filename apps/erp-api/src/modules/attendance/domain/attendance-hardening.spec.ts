import { describe, expect, it } from 'vitest';

import {
  AttendanceDomainError,
  businessDateAt,
  closeAttendanceMonth,
  createAttendanceCorrection,
  createAttendanceSourceFact,
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
  restoreAttendanceSourceFactFromMigration,
  type AttendanceCorrection,
  type AttendanceDailySummary,
  type AttendanceSourceFact,
} from './attendance.js';

const closeAt = new Date('2026-04-03T00:00:00.000Z');
const cutoff = '2026-04-02T23:59:59.000Z';
const zeroImpact = Object.freeze({
  workedMinutes: 0,
  leaveMinutes: 0,
  overtimeMinutes: 0,
  absentMinutes: 0,
});
const defaultImpact = Object.freeze({
  workedMinutes: 480,
  leaveMinutes: 0,
  overtimeMinutes: 0,
  absentMinutes: 0,
});

const sourceInput = Object.freeze({
  id: 'fact-001',
  tenantId: 'tenant-001',
  employeeId: 'employee-001',
  providerCode: 'dingtalk',
  factType: 'shift' as const,
  occurredAt: '2026-04-01T01:00:00.000Z',
  timeZone: 'Asia/Shanghai',
  impact: defaultImpact,
  sourceObservedAt: '2026-04-01T01:01:00.000Z',
});

function source(
  overrides: Readonly<Record<string, unknown>> = {},
  now = new Date('2026-04-02T12:00:00.000Z'),
): AttendanceSourceFact {
  return createAttendanceSourceFact({ ...sourceInput, ...overrides }, now);
}

function correction(
  fact = source(),
  overrides: Readonly<Record<string, unknown>> = {},
  now = new Date('2026-04-01T02:01:00.000Z'),
): AttendanceCorrection {
  return createAttendanceCorrection({
    id: 'correction-001',
    tenantId: fact.tenantId,
    employeeId: fact.employeeId,
    sourceFactId: fact.id,
    businessDate: fact.businessDate,
    replacementImpact: { ...defaultImpact, workedMinutes: 420 },
    reasonCode: 'MISSED_BREAK',
    approvalReferenceType: 'approval_instance',
    approvalInstanceId: 'approval-001',
    approvalHistoryId: null,
    approvalEvidenceId: 'evidence-001',
    approvedAt: '2026-04-01T02:00:00.000Z',
    ...overrides,
  }, now);
}

function snapshotInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof closeAttendanceMonth>[0] {
  return {
    id: 'snapshot-001',
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    month: '2026-04',
    snapshotVersion: 1,
    rulesetVersion: 'attendance-cn-v1',
    sourceCutoffAt: cutoff,
    facts: [],
    corrections: [],
    previousSnapshotId: null,
    supersessionEvidenceId: null,
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AttendanceDomainError);
  expect(thrown).toMatchObject({ code });
}

describe('Attendance 核心领域失败关闭', () => {
  it.each([
    ['事实标识', { id: 'bad id' }, 'ATTENDANCE_FACT_ID_INVALID'],
    ['租户标识', { tenantId: '' }, 'ATTENDANCE_TENANT_INVALID'],
    ['员工标识', { employeeId: 'bad employee' }, 'ATTENDANCE_EMPLOYEE_INVALID'],
    ['来源标识', { providerCode: 'bad provider' }, 'ATTENDANCE_PROVIDER_INVALID'],
    ['事实类型', { factType: 'unknown' }, 'ATTENDANCE_FACT_TYPE_INVALID'],
    ['发生时间', { occurredAt: '2026-02-30T01:00:00.000Z' }, 'ATTENDANCE_OCCURRED_AT_INVALID'],
    ['观测时间', { sourceObservedAt: 'not-an-instant' }, 'ATTENDANCE_SOURCE_TIME_INVALID'],
    ['观测倒置', {
      occurredAt: '2026-04-01T01:01:00.000Z',
      sourceObservedAt: '2026-04-01T01:00:00.000Z',
    }, 'ATTENDANCE_SOURCE_TIME_INVALID'],
    ['观测晚于 ERP 登记', {
      sourceObservedAt: '2026-04-02T12:00:01.000Z',
    }, 'ATTENDANCE_SOURCE_TIME_INVALID'],
    ['负数分钟', {
      impact: { ...defaultImpact, workedMinutes: -1 },
    }, 'ATTENDANCE_MINUTES_INVALID'],
    ['非整数分钟', {
      impact: { ...defaultImpact, workedMinutes: 1.5 },
    }, 'ATTENDANCE_MINUTES_INVALID'],
    ['超月上限', {
      impact: { ...defaultImpact, workedMinutes: 44_641 },
    }, 'ATTENDANCE_MINUTES_INVALID'],
  ])('%s 非法时拒绝源事实', (_name, overrides, code) => {
    expectCode(() => source(overrides), code);
  });

  it('拒绝非法当前时间与 IANA 时区，并接受无毫秒的规范 UTC 时间', () => {
    expectCode(() => source({}, new Date('invalid')), 'ATTENDANCE_NOW_INVALID');
    expectCode(() => businessDateAt(sourceInput.occurredAt, ''), 'ATTENDANCE_TIME_ZONE_INVALID');
    expectCode(
      () => businessDateAt(sourceInput.occurredAt, 'Not/AZone'),
      'ATTENDANCE_TIME_ZONE_INVALID',
    );
    expect(businessDateAt('2026-04-01T01:00:00Z', 'UTC')).toBe('2026-04-01');
  });

  it.each([
    ['非法来源', { providerCode: 'DINGTALK' }],
    ['发生晚于观测', {
      occurredAt: '2026-04-01T01:02:00.000Z',
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
    }],
    ['观测晚于落库', {
      sourceObservedAt: '2026-04-01T01:03:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }],
    ['落库远期', { createdAt: '2026-04-03T00:06:00.000Z' }],
  ])('%s 的迁移源事实失败关闭', (_name, overrides) => {
    const original = source();
    expectCode(() => restoreAttendanceSourceFactFromMigration({
      ...original,
      ...overrides,
    }, closeAt), 'ATTENDANCE_MIGRATION_SOURCE_TIMELINE_INVALID');
  });

  it('迁移时间必须是存在且带毫秒的规范 UTC instant', () => {
    const original = source();
    expectCode(() => restoreAttendanceSourceFactFromMigration({
      ...original,
      occurredAt: '2026-04-01T01:00:00Z',
    }, closeAt), 'ATTENDANCE_MIGRATION_SOURCE_TIME_INVALID');
    expectCode(() => restoreAttendanceSourceFactFromMigration({
      ...original,
      occurredAt: '2026-02-30T01:00:00.000Z',
    }, closeAt), 'ATTENDANCE_MIGRATION_SOURCE_TIME_INVALID');
  });

  it.each([
    ['审批实例缺失', {
      approvalInstanceId: null,
    }, 'ATTENDANCE_CORRECTION_APPROVAL_REFERENCE_INVALID'],
    ['审批实例混入历史', {
      approvalHistoryId: 'history-001',
    }, 'ATTENDANCE_CORRECTION_APPROVAL_REFERENCE_INVALID'],
    ['历史审批混入实例', {
      approvalReferenceType: 'legacy_history',
      approvalInstanceId: 'approval-001',
      approvalHistoryId: 'history-001',
    }, 'ATTENDANCE_CORRECTION_APPROVAL_REFERENCE_INVALID'],
    ['审批引用非法', {
      approvalInstanceId: 'bad approval',
    }, 'ATTENDANCE_CORRECTION_REFERENCE_INVALID'],
    ['不存在的业务日期', {
      businessDate: '2026-04-99',
    }, 'ATTENDANCE_BUSINESS_DATE_INVALID'],
    ['原因码非法', {
      reasonCode: 'bad-reason',
    }, 'ATTENDANCE_REASON_INVALID'],
    ['批准时间非法', {
      approvedAt: '2026-02-30T01:00:00.000Z',
    }, 'ATTENDANCE_APPROVED_AT_INVALID'],
    ['替换分钟非法', {
      replacementImpact: { ...defaultImpact, absentMinutes: -1 },
    }, 'ATTENDANCE_MINUTES_INVALID'],
  ])('%s 时拒绝修订', (_name, overrides, code) => {
    expectCode(() => correction(source(), overrides), code);
  });

  it('修订支持严格历史审批引用并拒绝非法当前时间', () => {
    const fact = source();
    const restored = correction(fact, {
      approvalReferenceType: 'legacy_history',
      approvalInstanceId: null,
      approvalHistoryId: 'history-001',
    });
    expect(restored.approvalHistoryId).toBe('history-001');
    expectCode(
      () => correction(fact, {}, new Date('invalid')),
      'ATTENDANCE_NOW_INVALID',
    );
  });

  it('迁移修订拒绝远期落库，且批准不得晚于落库', () => {
    const original = correction();
    expectCode(() => restoreAttendanceCorrectionFromMigration({
      ...original,
      approvedAt: '2026-04-01T02:02:00.000Z',
    }, closeAt), 'ATTENDANCE_MIGRATION_CORRECTION_TIMELINE_INVALID');
    expectCode(() => restoreAttendanceCorrectionFromMigration({
      ...original,
      createdAt: '2026-04-03T00:06:00.000Z',
    }, closeAt), 'ATTENDANCE_MIGRATION_CORRECTION_TIMELINE_INVALID');
  });

  it.each([
    ['快照引用', { id: 'bad id' }, 'ATTENDANCE_SNAPSHOT_REFERENCE_INVALID'],
    ['月份', { month: '2026-13' }, 'ATTENDANCE_MONTH_INVALID'],
    ['版本非整数', { snapshotVersion: 1.5 }, 'ATTENDANCE_SNAPSHOT_VERSION_INVALID'],
    ['版本小于一', { snapshotVersion: 0 }, 'ATTENDANCE_SNAPSHOT_VERSION_INVALID'],
    ['规则集', { rulesetVersion: 'bad ruleset' }, 'ATTENDANCE_RULESET_INVALID'],
    ['截止时间', { sourceCutoffAt: 'not-an-instant' }, 'ATTENDANCE_CUTOFF_INVALID'],
    ['未来截止', {
      sourceCutoffAt: '2026-04-04T00:00:00.000Z',
    }, 'ATTENDANCE_CUTOFF_IN_FUTURE'],
    ['首版前序', {
      previousSnapshotId: 'snapshot-old',
    }, 'ATTENDANCE_INITIAL_SNAPSHOT_CHAIN_INVALID'],
    ['首版重开证据', {
      supersessionEvidenceId: 'approval-001',
    }, 'ATTENDANCE_INITIAL_SNAPSHOT_CHAIN_INVALID'],
    ['重开缺前序', {
      snapshotVersion: 2,
      supersessionEvidenceId: 'approval-001',
    }, 'ATTENDANCE_SUPERSESSION_EVIDENCE_REQUIRED'],
    ['重开缺证据', {
      snapshotVersion: 2,
      previousSnapshotId: 'snapshot-old',
    }, 'ATTENDANCE_SUPERSESSION_EVIDENCE_REQUIRED'],
    ['重开前序非法', {
      snapshotVersion: 2,
      previousSnapshotId: 'bad id',
      supersessionEvidenceId: 'approval-001',
    }, 'ATTENDANCE_PREVIOUS_SNAPSHOT_INVALID'],
    ['重开证据非法', {
      snapshotVersion: 2,
      previousSnapshotId: 'snapshot-old',
      supersessionEvidenceId: 'bad evidence',
    }, 'ATTENDANCE_SUPERSESSION_EVIDENCE_INVALID'],
  ])('%s 非法时拒绝月结', (_name, overrides, code) => {
    expectCode(() => closeAttendanceMonth(snapshotInput(overrides), closeAt), code);
  });

  it('重开链合法时形成第二版活动快照', () => {
    const result = closeAttendanceMonth(snapshotInput({
      id: 'snapshot-002',
      snapshotVersion: 2,
      previousSnapshotId: 'snapshot-001',
      supersessionEvidenceId: 'approval-reopen-001',
    }), closeAt);
    expect(result).toMatchObject({
      snapshotVersion: 2,
      previousSnapshotId: 'snapshot-001',
      supersessionEvidenceId: 'approval-reopen-001',
      status: 'active',
    });
  });

  it('拒绝重复事实和同一事实的重复修订', () => {
    const fact = source();
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact, fact],
    }), closeAt), 'ATTENDANCE_FACT_DUPLICATE');
    const first = correction(fact);
    const second = correction(fact, { id: 'correction-002' });
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact],
      corrections: [first, second],
    }), closeAt), 'ATTENDANCE_CORRECTION_DUPLICATE');
  });

  it.each([
    ['租户', { tenantId: 'tenant-other' }],
    ['员工', { employeeId: 'employee-other' }],
    ['月份', { businessDate: '2026-05-01' }],
    ['受损日期', { businessDate: '2026-04-99' }],
  ])('拒绝%s越界的源事实', (_name, overrides) => {
    const tampered = Object.freeze({ ...source(), ...overrides });
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [tampered],
    }), closeAt), 'ATTENDANCE_FACT_OUT_OF_SCOPE');
  });

  it('拒绝截止时间后的源观测、ERP 落库和受损分钟', () => {
    const fact = source();
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [{ ...fact, sourceObservedAt: '2026-04-03T00:00:00.000Z' }],
    }), closeAt), 'ATTENDANCE_FACT_AFTER_CUTOFF');
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [{ ...fact, createdAt: '2026-04-03T00:00:00.000Z' }],
    }), closeAt), 'ATTENDANCE_FACT_AFTER_CUTOFF');
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [{ ...fact, impact: { ...defaultImpact, workedMinutes: -1 } }],
    }), closeAt), 'ATTENDANCE_MINUTES_INVALID');
  });

  it.each([
    ['不存在的源事实', { sourceFactId: 'fact-missing' }],
    ['租户', { tenantId: 'tenant-other' }],
    ['员工', { employeeId: 'employee-other' }],
    ['业务日期', { businessDate: '2026-04-02' }],
    ['月份', { businessDate: '2026-05-01' }],
  ])('拒绝%s不匹配的修订', (_name, overrides) => {
    const fact = source();
    const tampered = Object.freeze({ ...correction(fact), ...overrides });
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact],
      corrections: [tampered],
    }), closeAt), 'ATTENDANCE_CORRECTION_OUT_OF_SCOPE');
  });

  it('拒绝截止后的修订审批、登记和受损替换分钟', () => {
    const fact = source();
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact],
      corrections: [{
        ...correction(fact),
        approvedAt: '2026-04-03T00:00:00.000Z',
      }],
    }), closeAt), 'ATTENDANCE_CORRECTION_AFTER_CUTOFF');
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact],
      corrections: [{
        ...correction(fact),
        createdAt: '2026-04-03T00:00:00.000Z',
      }],
    }), closeAt), 'ATTENDANCE_CORRECTION_AFTER_CUTOFF');
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [fact],
      corrections: [{
        ...correction(fact),
        replacementImpact: { ...defaultImpact, leaveMinutes: -1 },
      }],
    }), closeAt), 'ATTENDANCE_MINUTES_INVALID');
  });

  it('规则日摘要按日期排序、冻结并进入快照总计', () => {
    const first = source();
    const second = source({
      id: 'fact-002',
      occurredAt: '2026-04-02T01:00:00.000Z',
      sourceObservedAt: '2026-04-02T01:01:00.000Z',
    });
    const summaries: readonly AttendanceDailySummary[] = [
      {
        businessDate: '2026-04-02',
        ...zeroImpact,
        workedMinutes: 420,
        sourceFactCount: 1,
        correctionCount: 0,
        digest: 'b'.repeat(43),
      },
      {
        businessDate: '2026-04-01',
        ...zeroImpact,
        workedMinutes: 480,
        sourceFactCount: 1,
        correctionCount: 0,
        digest: 'a'.repeat(43),
      },
    ];
    const result = closeAttendanceMonth(snapshotInput({
      facts: [first, second],
      evaluatedDailySummaries: summaries,
    }), closeAt);
    expect(result.workedMinutes).toBe(900);
    expect(result.dailySummaries.map((summary) => summary.businessDate)).toEqual([
      '2026-04-01',
      '2026-04-02',
    ]);
    expect(Object.isFrozen(result.dailySummaries)).toBe(true);
    expect(Object.isFrozen(result.dailySummaries[0])).toBe(true);
  });

  it.each([
    ['日期格式', { businessDate: 'bad-date' }, 'ATTENDANCE_RULE_EVALUATION_DATE_INVALID'],
    ['不存在日期', {
      businessDate: '2026-04-99',
    }, 'ATTENDANCE_RULE_EVALUATION_DATE_INVALID'],
    ['跨月日期', {
      businessDate: '2026-05-01',
    }, 'ATTENDANCE_RULE_EVALUATION_DATE_INVALID'],
    ['事实计数负数', {
      sourceFactCount: -1,
    }, 'ATTENDANCE_RULE_EVALUATION_INVALID'],
    ['事实计数非整数', {
      sourceFactCount: 0.5,
    }, 'ATTENDANCE_RULE_EVALUATION_INVALID'],
    ['修订计数负数', {
      correctionCount: -1,
    }, 'ATTENDANCE_RULE_EVALUATION_INVALID'],
    ['修订计数非整数', {
      correctionCount: 0.5,
    }, 'ATTENDANCE_RULE_EVALUATION_INVALID'],
    ['摘要非法', {
      digest: 'invalid',
    }, 'ATTENDANCE_RULE_EVALUATION_INVALID'],
    ['分钟非法', {
      workedMinutes: -1,
    }, 'ATTENDANCE_MINUTES_INVALID'],
  ])('%s 的规则日摘要失败关闭', (_name, overrides, code) => {
    const summary = {
      businessDate: '2026-04-01',
      ...zeroImpact,
      sourceFactCount: 0,
      correctionCount: 0,
      digest: 'a'.repeat(43),
      ...overrides,
    };
    expectCode(() => closeAttendanceMonth(snapshotInput({
      evaluatedDailySummaries: [summary],
    }), closeAt), code);
  });

  it('拒绝重复规则日摘要和源事实/修订计数不一致', () => {
    const summary = Object.freeze({
      businessDate: '2026-04-01',
      ...zeroImpact,
      sourceFactCount: 0,
      correctionCount: 0,
      digest: 'a'.repeat(43),
    });
    expectCode(() => closeAttendanceMonth(snapshotInput({
      evaluatedDailySummaries: [summary, summary],
    }), closeAt), 'ATTENDANCE_RULE_EVALUATION_DATE_INVALID');
    expectCode(() => closeAttendanceMonth(snapshotInput({
      facts: [source()],
      evaluatedDailySummaries: [summary],
    }), closeAt), 'ATTENDANCE_RULE_EVALUATION_COUNT_MISMATCH');
  });

  it('旧摘要按日期、发生时间和事实 ID 稳定排序并累计同日影响', () => {
    const late = source({
      id: 'fact-003',
      occurredAt: '2026-04-02T02:00:00.000Z',
      sourceObservedAt: '2026-04-02T02:01:00.000Z',
      impact: { ...defaultImpact, workedMinutes: 60 },
    });
    const sameTimeSecondId = source({
      id: 'fact-002',
      occurredAt: '2026-04-02T01:00:00.000Z',
      sourceObservedAt: '2026-04-02T01:01:00.000Z',
      impact: { ...defaultImpact, workedMinutes: 120 },
    });
    const sameTimeFirstId = source({
      id: 'fact-001',
      occurredAt: '2026-04-02T01:00:00.000Z',
      sourceObservedAt: '2026-04-02T01:01:00.000Z',
      impact: { ...defaultImpact, workedMinutes: 180 },
    });
    const result = closeAttendanceMonth(snapshotInput({
      facts: [late, sameTimeSecondId, sameTimeFirstId],
    }), closeAt);
    expect(result.dailySummaries).toHaveLength(1);
    expect(result.workedMinutes).toBe(360);
    expect(result.dailySummaries[0]?.sourceFactCount).toBe(3);
  });

  it('迁移月结拒绝远期关账时间', () => {
    expectCode(() => restoreAttendanceMonthFromMigration({
      ...snapshotInput(),
      closedAt: '2026-04-03T00:06:00.000Z',
    }, closeAt), 'ATTENDANCE_MIGRATION_MONTH_TIMELINE_INVALID');
  });
});
