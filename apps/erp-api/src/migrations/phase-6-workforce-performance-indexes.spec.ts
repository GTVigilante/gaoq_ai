import { describe, expect, it } from 'vitest';

import { buildPhaseSixWorkforcePerformanceIndexManifest } from './phase-6-workforce-performance-indexes.js';

describe('Phase 6 组织协作与绩效索引迁移', () => {
  it('覆盖六个新增集合及其租户内唯一主键', () => {
    const manifest = buildPhaseSixWorkforcePerformanceIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'workforce_reporting_lines', 'workforce_hrbp_assignments', 'performance_templates',
      'performance_cycles', 'performance_assignments', 'performance_payroll_snapshots',
    ]));
    for (const collection of new Set(manifest.map((item) => item.collection))) {
      expect(manifest.some((item) => item.collection === collection && item.key.tenantId === 1 && item.options.unique === true)).toBe(true);
    }
  });

  it('为直属主管、HRBP 待办和算薪快照提供固定查询索引', () => {
    const manifest = buildPhaseSixWorkforcePerformanceIndexManifest();
    expect(manifest.some((item) => item.collection === 'workforce_reporting_lines' && item.key.employeeId === 1 && item.key.effectiveFrom === -1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'performance_assignments' && item.key.managerEmployeeId === 1 && item.key.status === 1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'performance_assignments' && item.key.hrbpEmployeeId === 1 && item.key.status === 1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'performance_payroll_snapshots' && item.key.cycleId === 1 && item.key.employeeId === 1)).toBe(true);
  });
});
