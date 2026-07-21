import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollShadowIndexManifest } from './phase-4-payroll-shadow-indexes.js';

describe('Phase 4 工资影子验证索引迁移', () => {
  it('唯一索引全部以可信租户开头并覆盖周期、来源、解释、签署和两期证据', () => {
    const manifest = buildPhaseFourPayrollShadowIndexManifest();
    for (const item of manifest) {
      if (item.options.unique === true) expect(Object.keys(item.key)[0]).toBe('tenantId');
    }
    for (const fields of [
      ['periodId'], ['payrollRunId'], ['sourceSystem', 'sourceExportId'], ['differenceId'],
      ['cycleId'], ['secondCycleId'], ['endPeriod'],
    ]) expect(manifest.some((item) =>
      item.options.unique === true && fields.every((field) => item.key[field] === 1))).toBe(true);
  });
});
