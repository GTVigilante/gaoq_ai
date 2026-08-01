import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollTaxIndexManifest } from './phase-4-payroll-tax-indexes.js';

describe('Phase 4 个税清单索引迁移', () => {
  it('全部唯一索引以可信租户开头并覆盖周期和提交回执', () => {
    const manifest = buildPhaseFourPayrollTaxIndexManifest();
    for (const item of manifest) {
      if (item.options.unique === true) expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    expect(manifest.some((item) => item.key.periodId === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) =>
      item.key.taxSubmissionId === 1 && item.options.unique === true)).toBe(true);
  });
});
