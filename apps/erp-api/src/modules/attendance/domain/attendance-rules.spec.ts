import { describe, expect, it } from 'vitest';

import type { Employment } from '../../org/domain/employment.js';
import {
  createAttendanceProviderCoverage,
  createAttendanceShiftAssignment,
  createAttendanceShiftRule,
  evaluateAttendanceMonth,
  type AttendanceProviderCoverage,
  type AttendanceShiftAssignment,
  type AttendanceShiftRule,
} from './attendance-rules.js';
import type { AttendanceCorrection, AttendanceSourceFact } from './attendance.js';

const TENANT_ID = 'tenant-001';
const EMPLOYEE_ID = 'employee-001';
const NOW = new Date('2026-05-01T01:00:00.000Z');

function rule(
  overrides: Partial<Omit<AttendanceShiftRule, 'createdAt'>> = {},
): AttendanceShiftRule {
  return createAttendanceShiftRule({
    id: 'shift-rule-night',
    tenantId: TENANT_ID,
    rulesetVersion: 'attendance-cn-2026-v1',
    shiftCode: 'NIGHT_SHIFT',
    timeZone: 'Asia/Shanghai',
    startLocalTime: '22:00',
    endLocalTime: '06:00',
    workdays: [3],
    plannedMinutes: 480,
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
    crossMidnightPunchOutGraceMinutes: 120,
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    governanceEvidenceId: 'approval-shift-rule-001',
    evidenceChecksum: 'r'.repeat(43),
    ...overrides,
  }, NOW);
}

function assignment(
  overrides: Partial<Omit<AttendanceShiftAssignment, 'createdAt'>> = {},
): AttendanceShiftAssignment {
  return createAttendanceShiftAssignment({
    id: 'shift-assignment-001',
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    shiftRuleId: 'shift-rule-night',
    providerCode: 'dingtalk',
    effectiveFrom: '2026-04-01',
    effectiveTo: '2026-04-01',
    governanceEvidenceId: 'approval-shift-assignment-001',
    evidenceChecksum: 'a'.repeat(43),
    ...overrides,
  }, NOW);
}

function employment(
  overrides: Partial<Employment> = {},
): Employment {
  return Object.freeze({
    id: 'employment-001',
    tenantId: TENANT_ID,
    personId: 'person-001',
    employeeId: EMPLOYEE_ID,
    onboardingInstanceId: 'onboarding-001',
    onboardingCompletionEvidenceId: 'onboarding-evidence-001',
    offerId: 'offer-001',
    signedEvidenceId: 'signed-evidence-001',
    terminationCareCaseId: 'care-001',
    terminationExecutionEvidenceId: 'execution-001',
    terminationEvidenceId: 'termination-001',
    status: 'resigned',
    effectiveFrom: '2026-04-01',
    effectiveTo: '2026-04-01',
    version: 2,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
    ...overrides,
  });
}

function coverage(
  overrides: Partial<Omit<AttendanceProviderCoverage, 'evidenceChecksum' | 'createdAt'>> = {},
): AttendanceProviderCoverage {
  return createAttendanceProviderCoverage({
    id: 'coverage-001',
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    providerCode: 'dingtalk',
    providerStateId: 'provider-state-001',
    providerMappingId: 'provider-mapping-001',
    month: '2026-04',
    throughBusinessDate: '2026-04-30',
    sourceCutoffAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }, NOW);
}

function fact(
  id: string,
  factType: AttendanceSourceFact['factType'],
  occurredAt: string,
  businessDate: string,
  overrides: Partial<AttendanceSourceFact> = {},
): AttendanceSourceFact {
  return Object.freeze({
    id,
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    providerCode: 'dingtalk',
    factType,
    occurredAt,
    timeZone: 'Asia/Shanghai',
    businessDate,
    impact: Object.freeze({
      workedMinutes: 0,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: 0,
    }),
    sourceObservedAt: '2026-04-02T00:01:00.000Z',
    createdAt: '2026-04-02T00:02:00.000Z',
    ...overrides,
  });
}

const punchIn = fact(
  'fact-punch-in',
  'punch_in',
  '2026-04-01T14:00:00.000Z',
  '2026-04-01',
);
const punchOut = fact(
  'fact-punch-out',
  'punch_out',
  '2026-04-01T22:00:00.000Z',
  '2026-04-02',
);

function evaluate(overrides: Partial<Parameters<typeof evaluateAttendanceMonth>[0]> = {}) {
  return evaluateAttendanceMonth({
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    month: '2026-04',
    rulesetVersion: 'attendance-cn-2026-v1',
    sourceCutoffAt: '2026-05-01T00:30:00.000Z',
    employments: [employment()],
    rules: [rule()],
    assignments: [assignment()],
    coverages: [coverage()],
    facts: [punchIn, punchOut],
    corrections: [],
    ...overrides,
  });
}

describe('Attendance 规则领域', () => {
  it('创建不可变版本班次并固定跨天、工作日、宽限与治理证据', () => {
    const value = rule();
    expect(value).toEqual(expect.objectContaining({
      rulesetVersion: 'attendance-cn-2026-v1',
      shiftCode: 'NIGHT_SHIFT',
      startLocalTime: '22:00',
      endLocalTime: '06:00',
      workdays: [3],
      plannedMinutes: 480,
    }));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.workdays)).toBe(true);
  });

  it.each([
    { rulesetVersion: 'invalid version' },
    { shiftCode: 'night-shift' },
    { startLocalTime: '24:00' },
    { endLocalTime: '6:00' },
    { workdays: [1, 1] },
    { workdays: [0] },
    { plannedMinutes: 481 },
    { lateGraceMinutes: 181 },
    { evidenceChecksum: 'invalid' },
    { effectiveFrom: '2026-02-30' },
    { effectiveFrom: '2026-04-02', effectiveTo: '2026-04-01' },
  ])('拒绝受损班次规则 %#', (overrides) => {
    expect(() => rule(overrides as never)).toThrow();
  });

  it('非跨天班次拒绝跨天签退宽限', () => {
    expect(() => rule({
      startLocalTime: '09:00',
      endLocalTime: '18:00',
      plannedMinutes: 480,
      crossMidnightPunchOutGraceMinutes: 1,
    })).toThrow('非跨天班次不得设置跨天签退宽限');
  });

  it('排班只接受固定 Provider、合法区间和治理证据摘要', () => {
    expect(assignment()).toEqual(expect.objectContaining({
      employeeId: EMPLOYEE_ID,
      providerCode: 'dingtalk',
      shiftRuleId: 'shift-rule-night',
    }));
    expect(() => assignment({ providerCode: 'op' as never })).toThrow();
    expect(() => assignment({
      effectiveFrom: '2026-04-02',
      effectiveTo: '2026-04-01',
    })).toThrow();
    expect(() => assignment({ evidenceChecksum: 'invalid' })).toThrow();
  });

  it('覆盖证明由来源状态、映射、月份、水位线和截止时间确定性生成摘要', () => {
    const first = coverage();
    const second = coverage();
    expect(first.evidenceChecksum).toBe(second.evidenceChecksum);
    expect(first.evidenceChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => coverage({ throughBusinessDate: '2026-02-30' })).toThrow();
    expect(() => coverage({ sourceCutoffAt: '2026-05-02T00:00:00.000Z' })).toThrow();
    expect(() => coverage({ providerCode: 'op' as never })).toThrow();
    expect(() => coverage({ month: '2026-13' })).toThrow();
  });

  it('构造器拒绝非法引用、时区长度和当前时间', () => {
    expect(() => rule({ id: 'invalid id' })).toThrow('资源标识非法');
    expect(() => rule({ timeZone: 'x'.repeat(65) })).toThrow('IANA 时区非法');
    expect(() => createAttendanceShiftAssignment({
      ...assignment(),
      createdAt: undefined,
    } as never, new Date(Number.NaN))).toThrow('当前时间非法');
  });

  it('夜班签退归属前一业务日并按 UTC 实际时长推导月结', () => {
    const result = evaluate();
    expect(result.facts).toHaveLength(2);
    expect(result.facts[1]?.businessDate).toBe('2026-04-01');
    expect(result.dailySummaries).toEqual([
      expect.objectContaining({
        businessDate: '2026-04-01',
        workedMinutes: 480,
        absentMinutes: 0,
        sourceFactCount: 2,
        correctionCount: 0,
      }),
    ]);
  });

  it('迟到和早退只在规则宽限外形成缺勤且不自动认定加班', () => {
    const result = evaluate({
      facts: [
        fact('fact-late', 'punch_in', '2026-04-01T14:20:00.000Z', '2026-04-01'),
        fact('fact-early', 'punch_out', '2026-04-01T21:40:00.000Z', '2026-04-02'),
      ],
    });
    expect(result.dailySummaries[0]).toEqual(expect.objectContaining({
      workedMinutes: 440,
      overtimeMinutes: 0,
      absentMinutes: 30,
    }));
  });

  it('没有打卡的工作日形成计划分钟缺勤', () => {
    const result = evaluate({ facts: [] });
    expect(result.dailySummaries[0]).toEqual(expect.objectContaining({
      workedMinutes: 0,
      absentMinutes: 480,
      sourceFactCount: 0,
    }));
  });

  it('批准修订覆盖单条源事实且摘要不包含原因正文', () => {
    const correction: AttendanceCorrection = Object.freeze({
      id: 'correction-001',
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      sourceFactId: punchIn.id,
      businessDate: '2026-04-01',
      replacementImpact: Object.freeze({
        workedMinutes: 420,
        leaveMinutes: 60,
        overtimeMinutes: 0,
        absentMinutes: 0,
      }),
      reasonCode: 'MISSED_PUNCH',
      approvalReferenceType: 'approval_instance',
      approvalInstanceId: 'approval-001',
      approvalHistoryId: null,
      approvalEvidenceId: 'approval-001',
      approvedAt: '2026-04-02T01:00:00.000Z',
      createdAt: '2026-04-02T01:01:00.000Z',
    });
    const result = evaluate({
      facts: [punchIn, punchOut],
      corrections: [correction],
    });
    expect(result.dailySummaries[0]).toEqual(expect.objectContaining({
      workedMinutes: 420,
      leaveMinutes: 60,
      absentMinutes: 0,
      correctionCount: 1,
    }));
    expect(JSON.stringify(result.dailySummaries)).not.toContain('MISSED_PUNCH');
  });

  it('普通白班支持同日上下班与非打卡事实，且忽略月外事实', () => {
    const dayRule = rule({
      id: 'shift-rule-day',
      shiftCode: 'DAY_SHIFT',
      startLocalTime: '09:00',
      endLocalTime: '18:00',
      workdays: [3],
      crossMidnightPunchOutGraceMinutes: 0,
    });
    const result = evaluate({
      rules: [dayRule],
      assignments: [assignment({ shiftRuleId: dayRule.id })],
      facts: [
        fact('fact-day-in', 'punch_in', '2026-04-01T01:00:00.000Z', '2026-04-01'),
        fact('fact-leave', 'leave', '2026-04-01T04:00:00.000Z', '2026-04-01', {
          impact: Object.freeze({
            workedMinutes: 0,
            leaveMinutes: 60,
            overtimeMinutes: 0,
            absentMinutes: 0,
          }),
        }),
        fact('fact-day-out', 'punch_out', '2026-04-01T10:00:00.000Z', '2026-04-01'),
        fact('fact-next-month', 'leave', '2026-05-01T01:00:00.000Z', '2026-05-01'),
      ],
    });
    expect(result.facts.map((value) => value.id)).not.toContain('fact-next-month');
    expect(result.dailySummaries[0]).toEqual(expect.objectContaining({
      workedMinutes: 480,
      leaveMinutes: 60,
      absentMinutes: 0,
      sourceFactCount: 3,
    }));
  });

  it('拒绝重复规则、重复修订和作用域受损的权威区间', () => {
    expect(() => evaluate({ rules: [rule(), rule()] })).toThrow('班次规则重复');
    const correction: AttendanceCorrection = Object.freeze({
      id: 'correction-duplicate',
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      sourceFactId: punchIn.id,
      businessDate: '2026-04-01',
      replacementImpact: Object.freeze({
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
      }),
      reasonCode: 'MISSED_PUNCH',
      approvalReferenceType: 'approval_instance',
      approvalInstanceId: 'approval-001',
      approvalHistoryId: null,
      approvalEvidenceId: 'approval-001',
      approvedAt: '2026-04-02T01:00:00.000Z',
      createdAt: '2026-04-02T01:01:00.000Z',
    });
    expect(() => evaluate({
      corrections: [correction, Object.freeze({ ...correction, id: 'correction-duplicate-2' })],
    })).toThrow('同一源事实存在多个生效修订');
    expect(() => evaluate({
      employments: [employment({ employeeId: 'employee-other' })],
    })).toThrow('劳动关系不属于当前租户或员工');
    expect(() => evaluate({
      assignments: [assignment({ employeeId: 'employee-other' })],
    })).toThrow('排班不属于当前租户或员工');
    expect(() => evaluate({
      assignments: [assignment({ shiftRuleId: 'shift-rule-missing' })],
    })).toThrow('班次规则不存在');
  });

  it.each([
    ['缺少劳动关系日期排班', { assignments: [] }, '缺少权威排班'],
    ['排班超出劳动关系', { employments: [] }, '排班超出劳动关系'],
    ['规则版本错配', { rulesetVersion: 'attendance-cn-v2' }, '版本或有效区间'],
    ['缺少 Provider 覆盖', { coverages: [] }, '缺少完整 Provider 覆盖证明'],
    ['水位线未覆盖月末', {
      coverages: [coverage({ throughBusinessDate: '2026-04-29' })],
    }, '覆盖证明与月结范围不匹配'],
    ['覆盖证明晚于截止时间', {
      sourceCutoffAt: '2026-04-30T23:59:59.999Z',
    }, '覆盖证明与月结范围不匹配'],
  ])('%s 时月结失败关闭', (_name, overrides, message) => {
    expect(() => evaluate(overrides as never)).toThrow(message);
  });

  it('拒绝重叠劳动关系和重叠排班', () => {
    expect(() => evaluate({
      employments: [employment(), employment({ id: 'employment-002' })],
    })).toThrow('有效区间存在重叠');
    expect(() => evaluate({
      assignments: [assignment(), assignment({ id: 'shift-assignment-002' })],
    })).toThrow('有效区间存在重叠');
  });

  it('拒绝未成对、乱序、过长以及非工作日未经审批的打卡', () => {
    expect(() => evaluate({ facts: [punchIn] })).toThrow('上下班打卡未成对');
    expect(() => evaluate({
      facts: [
        fact('fact-out-first', 'punch_out', '2026-04-01T14:00:00.000Z', '2026-04-01'),
        fact('fact-in-second', 'punch_in', '2026-04-01T15:00:00.000Z', '2026-04-01'),
      ],
    })).toThrow('上下班打卡顺序非法');
    expect(() => evaluate({
      facts: [
        fact('fact-long-in', 'punch_in', '2026-03-31T21:00:00.000Z', '2026-04-01'),
        fact('fact-long-out', 'punch_out', '2026-04-01T22:01:00.000Z', '2026-04-02'),
      ],
    })).toThrow('打卡时长非法');
    expect(() => evaluate({
      rules: [rule({ workdays: [4] })],
    })).toThrow('非工作日打卡必须通过加班或修订审批');
  });

  it('拒绝事实跨租户、时区错配、晚于截止时间和覆盖证明摘要篡改', () => {
    expect(() => evaluate({
      facts: [fact('fact-other', 'punch_in', punchIn.occurredAt, punchIn.businessDate, {
        tenantId: 'tenant-other',
      })],
    })).toThrow('源事实不属于当前租户或员工');
    expect(() => evaluate({
      facts: [Object.freeze({ ...punchIn, timeZone: 'UTC' }), punchOut],
    })).toThrow('源事实时区与权威班次不一致');
    expect(() => evaluate({
      facts: [Object.freeze({
        ...punchIn,
        sourceObservedAt: '2026-05-01T00:31:00.000Z',
      }), punchOut],
    })).toThrow('源事实晚于月结截止时间');
    expect(() => evaluate({
      coverages: [Object.freeze({ ...coverage(), evidenceChecksum: 'x'.repeat(43) })],
    })).toThrow('覆盖证明摘要不一致');
  });
});
