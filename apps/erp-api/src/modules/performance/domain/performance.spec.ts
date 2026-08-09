import { describe, expect, it } from 'vitest';

import {
  appealPerformance,
  calibratePerformance,
  confirmPerformance,
  createPerformanceAssignment,
  createPerformanceCycle,
  createPerformanceTemplate,
  finalizePerformance,
  publishPerformanceCycle,
  submitManagerReview,
  submitSelfReview,
  type PerformanceAssignment,
} from './performance.js';

const NOW = new Date('2026-08-09T08:00:00.000Z');
const LATER = new Date('2026-08-10T08:00:00.000Z');

function template() {
  return createPerformanceTemplate({
    id: 'template-001', tenantId: 'tenant-001', name: '季度绩效标准模板',
    okrWeightBps: 4000, kpiWeightBps: 4000, competencyWeightBps: 2000,
    thresholds: { S: 9000, A: 8000, B: 7000, C: 6000 },
    coefficients: { S: 15000, A: 12000, B: 10000, C: 8000, D: 0 },
  }, NOW);
}

function assignment(): PerformanceAssignment {
  return createPerformanceAssignment({
    id: 'assignment-001', tenantId: 'tenant-001', cycleId: 'cycle-001',
    employeeId: 'employee-001', employmentId: 'employment-001', departmentId: 'department-001',
    managerEmployeeId: 'employee-002', hrbpEmployeeId: 'employee-003',
  }, NOW);
}

describe('performance domain', () => {
  it('固定采用 40/40/20 且拒绝不闭合权重与阈值', () => {
    expect(template()).toMatchObject({ okrWeightBps: 4000, kpiWeightBps: 4000, competencyWeightBps: 2000 });
    expect(() => createPerformanceTemplate({
      ...template(), id: 'template-002', okrWeightBps: 3999,
    }, NOW)).toThrow('PERFORMANCE_TEMPLATE_WEIGHTS_INVALID');
    expect(() => createPerformanceTemplate({
      ...template(), id: 'template-003', thresholds: { S: 8000, A: 8000, B: 7000, C: 6000 },
    }, NOW)).toThrow('PERFORMANCE_TEMPLATE_THRESHOLDS_INVALID');
  });

  it('发布周期时冻结覆盖人数', () => {
    const cycle = createPerformanceCycle({
      id: 'cycle-001', tenantId: 'tenant-001', name: '2026 第三季度', templateId: template().id,
      startDate: '2026-07-01', endDate: '2026-09-30',
    }, NOW);
    expect(publishPerformanceCycle(cycle, 42, LATER)).toMatchObject({ status: 'published', assignmentCount: 42, version: 2 });
    expect(() => publishPerformanceCycle(cycle, 0, LATER)).toThrow('PERFORMANCE_CYCLE_PUBLISH_INVALID');
  });

  it('按自评、主管、HRBP校准、确认的顺序生成等级与系数', () => {
    const self = submitSelfReview(assignment(), 8200, 'evidence-self', LATER);
    const manager = submitManagerReview(self, 7900, 'evidence-manager', LATER);
    const calibrated = calibratePerformance(manager, 8050, 'cross_team_alignment', LATER);
    const confirmed = confirmPerformance(calibrated, LATER);
    const finalized = finalizePerformance(confirmed, template(), null, null, LATER);
    expect(finalized).toMatchObject({ status: 'finalized', finalScoreBps: 8050, rating: 'A', coefficientBps: 12000 });
    expect(finalized.version).toBe(6);
  });

  it('申诉必须携带证据，且结案必须给出有原因的复核分数', () => {
    const self = submitSelfReview(assignment(), 8200, 'evidence-self', LATER);
    const manager = submitManagerReview(self, 7900, 'evidence-manager', LATER);
    const calibrated = calibratePerformance(manager, 8050, 'cross_team_alignment', LATER);
    const appealed = appealPerformance(calibrated, 'evidence_disputed', 'appeal-evidence', LATER);
    expect(() => finalizePerformance(appealed, template(), null, null, LATER)).toThrow('PERFORMANCE_APPEAL_RESOLUTION_INVALID');
    expect(finalizePerformance(appealed, template(), 7800, 'appeal_adjusted', LATER)).toMatchObject({ rating: 'B', coefficientBps: 10000 });
  });
});
