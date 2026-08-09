import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  PerformanceAssignmentRecordSchema,
  PerformanceCycleRecordSchema,
  PerformanceTemplateRecordSchema,
  type PerformanceAssignmentRecord,
  type PerformanceCycleRecord,
  type PerformanceTemplateRecord,
} from './performance.schemas.js';

const mongoose = new Mongoose();
const TemplateModel = mongoose.model<PerformanceTemplateRecord>('SpecPerformanceTemplate', PerformanceTemplateRecordSchema);
const CycleModel = mongoose.model<PerformanceCycleRecord>('SpecPerformanceCycle', PerformanceCycleRecordSchema);
const AssignmentModel = mongoose.model<PerformanceAssignmentRecord>('SpecPerformanceAssignment', PerformanceAssignmentRecordSchema);

const TEMPLATE = {
  id: 'template-001', tenantId: 'tenant-001', name: '季度绩效标准模板',
  okrWeightBps: 4000, kpiWeightBps: 4000, competencyWeightBps: 2000,
  thresholds: { S: 9000, A: 8000, B: 7000, C: 6000 },
  coefficients: { S: 15000, A: 12000, B: 10000, C: 8000, D: 0 }, version: 1,
};
const ASSIGNMENT = {
  id: 'assignment-001', tenantId: 'tenant-001', cycleId: 'cycle-001', employeeId: 'employee-001',
  employmentId: 'employment-001', departmentId: 'department-001', managerEmployeeId: 'employee-002',
  hrbpEmployeeId: 'employee-003', status: 'goal_setting', selfScoreBps: null, managerScoreBps: null,
  calibratedScoreBps: null, finalScoreBps: null, rating: null, coefficientBps: null,
  selfEvidenceRef: null, managerEvidenceRef: null, calibrationReasonCode: null,
  appealReasonCode: null, appealEvidenceRef: null, version: 1,
};

describe('performance schemas', () => {
  it('模板在持久化边界校验权重、等级阈值和系数', async () => {
    await expect(new TemplateModel(TEMPLATE).validate()).resolves.toBeUndefined();
    await expect(new TemplateModel({ ...TEMPLATE, okrWeightBps: 3999 }).validate()).rejects.toThrow('PERFORMANCE_TEMPLATE_INVARIANT_INVALID');
    await expect(new TemplateModel({ ...TEMPLATE, thresholds: { ...TEMPLATE.thresholds, S: 8000 } }).validate()).rejects.toThrow('PERFORMANCE_TEMPLATE_INVARIANT_INVALID');
  });

  it('周期在持久化边界绑定状态、覆盖人数与发布时间', async () => {
    const draft = { id: 'cycle-001', tenantId: 'tenant-001', name: '2026 第三季度', templateId: 'template-001', startDate: '2026-07-01', endDate: '2026-09-30', status: 'draft', assignmentCount: 0, publishedAt: null, version: 1 };
    await expect(new CycleModel(draft).validate()).resolves.toBeUndefined();
    await expect(new CycleModel({ ...draft, status: 'published', assignmentCount: 0 }).validate()).rejects.toThrow('PERFORMANCE_CYCLE_INVARIANT_INVALID');
  });

  it('任务状态必须与评分、证据、申诉和终态结果成套存在', async () => {
    await expect(new AssignmentModel(ASSIGNMENT).validate()).resolves.toBeUndefined();
    await expect(new AssignmentModel({ ...ASSIGNMENT, status: 'manager_review', selfScoreBps: 8000 }).validate()).rejects.toThrow('PERFORMANCE_ASSIGNMENT_INVARIANT_INVALID');
    await expect(new AssignmentModel({
      ...ASSIGNMENT, status: 'finalized', selfScoreBps: 8000, selfEvidenceRef: 'evidence-self',
      managerScoreBps: 7900, managerEvidenceRef: 'evidence-manager', calibratedScoreBps: 8100,
      calibrationReasonCode: 'cross_team_alignment', finalScoreBps: 8100, rating: 'A', coefficientBps: 12000,
    }).validate()).resolves.toBeUndefined();
  });
});
