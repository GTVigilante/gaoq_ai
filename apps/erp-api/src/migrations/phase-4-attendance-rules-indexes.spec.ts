import { describe, expect, it } from 'vitest';

import {
  buildPhaseFourAttendanceRulesIndexManifest,
} from './phase-4-attendance-rules-indexes.js';

describe('Phase 4 Attendance 规则索引迁移', () => {
  it('清单只包含规则、排班、并发守卫和覆盖证明四个新增集合', () => {
    const manifest = buildPhaseFourAttendanceRulesIndexManifest();
    expect([...new Set(manifest.map((entry) => entry.collection))].sort()).toEqual([
      'attendance_provider_coverages',
      'attendance_shift_assignment_guards',
      'attendance_shift_assignments',
      'attendance_shift_rules',
    ]);
    const uniqueRule = manifest.find((entry) =>
      entry.collection === 'attendance_shift_rules' &&
      JSON.stringify(entry.key) ===
        JSON.stringify({ tenantId: 1, rulesetVersion: 1, shiftCode: 1 }));
    expect(uniqueRule?.options.unique).toBe(true);
    expect(manifest.some((entry) =>
      entry.collection === 'attendance_shift_assignments' &&
      JSON.stringify(entry.key) === JSON.stringify({
        tenantId: 1,
        employeeId: 1,
        effectiveFrom: 1,
        effectiveTo: 1,
      }))).toBe(true);
    expect(manifest.some((entry) =>
      entry.collection === 'attendance_provider_coverages' &&
      JSON.stringify(entry.key) === JSON.stringify({
        tenantId: 1,
        employeeId: 1,
        month: 1,
        sourceCutoffAt: -1,
      }))).toBe(true);
  });

  it('所有唯一约束都带 tenantId 前缀且不存在删除索引操作', () => {
    const manifest = buildPhaseFourAttendanceRulesIndexManifest();
    for (const item of manifest) {
      expect(Object.keys(item.key)[0]).toBe('tenantId');
      expect(item).not.toHaveProperty('drop');
    }
  });
});
