import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollAnnualIndexManifest } from './phase-4-payroll-annual-indexes.js';

describe('Phase 4 年度工资代扣索引迁移', () => {
  it('按租户、员工、税年和版本追加核对证据', () => {
    const manifest = buildPhaseFourPayrollAnnualIndexManifest();
    for (const item of manifest) {
      if (item.options.unique === true) expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    expect(manifest.some((item) =>
      item.collection === 'payroll_annual_reconciliations' &&
      item.key.employeeId === 1 && item.key.taxYear === 1 &&
      item.key.version === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'payroll_annual_reconciliations' &&
      item.key.taxYear === 1 && item.key.status === 1)).toBe(true);
  });
});
