import { describe, expect, it } from 'vitest';

import {
  buildPhaseFourAttendanceRuleIndexManifest,
} from './phase-4-attendance-rule-indexes.js';

describe('Phase 4 Attendance 规则索引追加迁移', () => {
  it('只追加班次计划和派生事实关联索引', () => {
    const manifest = buildPhaseFourAttendanceRuleIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'attendance_shift_plans',
      'attendance_source_facts',
    ]));
    expect(manifest.some((item) =>
      item.collection === 'attendance_shift_plans' &&
      item.key.sourcePlanBlindIndexes === 1 &&
      item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'attendance_source_facts' &&
      item.key.shiftPlanId === 1 &&
      item.options.unique === true &&
      item.options.partialFilterExpression !== undefined,
    )).toBe(true);
  });
});
