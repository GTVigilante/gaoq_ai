import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollAdjustmentIndexManifest } from './phase-4-payroll-adjustment-indexes.js';

describe('Phase 4 工资调整索引迁移', () => {
  it('以租户隔离调整编号并提供期间状态检索', () => {
    const manifest = buildPhaseFourPayrollAdjustmentIndexManifest();
    for (const item of manifest) {
      if (item.options.unique === true) expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    expect(manifest.some((item) =>
      item.collection === 'payroll_adjustments' &&
      item.key.originalCalculationLineId === 1 &&
      item.key.adjustmentNumber === 1 &&
      item.options.unique === true)).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'payroll_adjustments' &&
      item.key.period === 1 && item.key.status === 1)).toBe(true);
  });
});
