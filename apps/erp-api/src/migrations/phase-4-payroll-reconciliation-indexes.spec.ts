import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollReconciliationIndexManifest } from './phase-4-payroll-reconciliation-indexes.js';

describe('Phase 4 四方对账索引迁移', () => {
  it('全部唯一索引以可信租户开头并阻止周期、运行和批次重复对账', () => {
    const manifest = buildPhaseFourPayrollReconciliationIndexManifest();
    for (const item of manifest) {
      if (item.options.unique === true) expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    for (const field of ['periodId', 'payrollRunId', 'batchId']) {
      expect(manifest.some((item) => item.key[field] === 1 && item.options.unique === true))
        .toBe(true);
    }
  });
});
