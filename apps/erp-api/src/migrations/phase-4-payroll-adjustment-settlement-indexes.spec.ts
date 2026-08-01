import { describe, expect, it } from 'vitest';

import {
  buildPhaseFourPayrollAdjustmentSettlementIndexManifest,
} from './phase-4-payroll-adjustment-settlement-indexes.js';

describe('Phase 4 工资调整结算索引迁移', () => {
  it('覆盖应收、不可变恢复凭证和税务更正且所有唯一键以可信租户开头', () => {
    const manifest = buildPhaseFourPayrollAdjustmentSettlementIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'payroll_adjustment_receivables',
      'payroll_adjustment_receivable_recoveries',
      'payroll_adjustment_tax_corrections',
    ]));
    expect(manifest.length).toBeGreaterThanOrEqual(8);
    for (const item of manifest) {
      expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    expect(manifest.some((item) =>
      item.collection === 'payroll_adjustment_receivables' &&
      item.key.tenantId === 1 &&
      item.key.adjustmentId === 1 &&
      item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'payroll_adjustment_tax_corrections' &&
      item.key.tenantId === 1 &&
      item.key.adjustmentId === 1 &&
      item.options.unique === true,
    )).toBe(true);
  });
});
