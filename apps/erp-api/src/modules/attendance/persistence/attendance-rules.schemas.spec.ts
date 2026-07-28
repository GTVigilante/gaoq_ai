import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AttendanceProviderCoverageRecordSchema,
  AttendanceShiftAssignmentGuardRecordSchema,
  AttendanceShiftAssignmentRecordSchema,
  AttendanceShiftRuleRecordSchema,
} from './attendance-rules.schemas.js';

const mongoose = new Mongoose();
const RuleModel = mongoose.model('SpecAttendanceShiftRule', AttendanceShiftRuleRecordSchema);
const AssignmentModel = mongoose.model(
  'SpecAttendanceShiftAssignment',
  AttendanceShiftAssignmentRecordSchema,
);
const AssignmentGuardModel = mongoose.model(
  'SpecAttendanceShiftAssignmentGuard',
  AttendanceShiftAssignmentGuardRecordSchema,
);
const CoverageModel = mongoose.model(
  'SpecAttendanceProviderCoverage',
  AttendanceProviderCoverageRecordSchema,
);

const rule = {
  id: 'shift-rule-001',
  tenantId: 'tenant-001',
  rulesetVersion: 'attendance-cn-v1',
  shiftCode: 'DAY_SHIFT',
  timeZone: 'Asia/Shanghai',
  startLocalTime: '09:00',
  endLocalTime: '18:00',
  workdays: [1, 2, 3, 4, 5],
  plannedMinutes: 480,
  lateGraceMinutes: 5,
  earlyLeaveGraceMinutes: 5,
  crossMidnightPunchOutGraceMinutes: 0,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  governanceEvidenceId: 'approval-rule-001',
  evidenceChecksum: 'r'.repeat(43),
};

describe('Attendance 规则持久化契约', () => {
  it('班次规则约束版本、工作日、时间、分钟、有效期和治理证据', async () => {
    await expect(new RuleModel(rule).validate()).resolves.toBeUndefined();
    await expect(new RuleModel({ ...rule, workdays: [] }).validate())
      .rejects.toThrow('组合约束非法');
    await expect(new RuleModel({ ...rule, workdays: [1, 1] }).validate())
      .rejects.toThrow('组合约束非法');
    await expect(new RuleModel({ ...rule, startLocalTime: '9:00' }).validate())
      .rejects.toThrow(/startLocalTime/);
    await expect(new RuleModel({
      ...rule,
      effectiveFrom: '2026-02-01',
      effectiveTo: '2026-01-31',
    }).validate()).rejects.toThrow('组合约束非法');
    await expect(new RuleModel({ ...rule, evidenceChecksum: 'invalid' }).validate())
      .rejects.toThrow(/evidenceChecksum/);
  });

  it('排班固定 Provider、有效区间和治理证据且不保存外部员工标识', async () => {
    const assignment = {
      id: 'assignment-001',
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      shiftRuleId: 'shift-rule-001',
      providerCode: 'dingtalk',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2026-04-30',
      governanceEvidenceId: 'approval-assignment-001',
      evidenceChecksum: 'a'.repeat(43),
    };
    const document = new AssignmentModel(assignment);
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('externalEmployeeId');
    await expect(new AssignmentModel({ ...assignment, providerCode: 'op' }).validate())
      .rejects.toThrow(/providerCode/);
    await expect(new AssignmentModel({
      ...assignment,
      effectiveFrom: '2026-05-01',
      effectiveTo: '2026-04-30',
    }).validate()).rejects.toThrow('有效区间非法');
  });

  it('覆盖证明只保存内部映射、水位、截止点和确定性摘要', async () => {
    const coverage = {
      id: 'coverage-001',
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      providerCode: 'feishu',
      providerStateId: 'state-001',
      providerMappingId: 'mapping-001',
      month: '2026-04',
      throughBusinessDate: '2026-04-30',
      sourceCutoffAt: new Date('2026-05-01T00:00:00.000Z'),
      evidenceChecksum: 'e'.repeat(43),
    };
    const document = new CoverageModel(coverage);
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('cursor');
    expect(document.toObject()).not.toHaveProperty('externalEmployeeId');
    await expect(new CoverageModel({ ...coverage, month: '2026-13' }).validate())
      .rejects.toThrow(/month/);
  });

  it('排班并发守卫只保存可信租户、员工和递增版本', async () => {
    await expect(new AssignmentGuardModel({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      revision: 1,
    }).validate()).resolves.toBeUndefined();
    await expect(new AssignmentGuardModel({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      revision: 0,
    }).validate()).rejects.toThrow(/revision/);
  });

  it('规则、排班、并发守卫和覆盖证明均有租户前缀唯一与范围查询索引', () => {
    expect(AttendanceShiftRuleRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [
        { tenantId: 1, rulesetVersion: 1, shiftCode: 1 },
        expect.objectContaining({ unique: true }),
      ],
    ]));
    expect(AttendanceShiftAssignmentRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [
        { tenantId: 1, employeeId: 1, effectiveFrom: 1 },
        expect.objectContaining({ unique: true }),
      ],
      [
        { tenantId: 1, employeeId: 1, effectiveFrom: 1, effectiveTo: 1 },
        expect.any(Object),
      ],
    ]));
    expect(AttendanceProviderCoverageRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [
        {
          tenantId: 1,
          employeeId: 1,
          providerCode: 1,
          month: 1,
          providerStateId: 1,
          providerMappingId: 1,
          sourceCutoffAt: 1,
        },
        expect.objectContaining({ unique: true }),
      ],
    ]));
    expect(AttendanceShiftAssignmentGuardRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, employeeId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
