import { describe, expect, it } from 'vitest';

import { buildPhaseFivePayrollTaxMigrationIndexManifest } from
  './phase-5-payroll-tax-migration-indexes.js';

describe('Phase 5 Payroll 个税迁移证据索引 v3', () => {
  it('不修改 v1/v2 并单独追加个税清单证据索引', () => {
    const manifest = buildPhaseFivePayrollTaxMigrationIndexManifest();
    const serialized = JSON.stringify(manifest);
    expect(serialized).toContain('payroll_tax_filings');
    expect(manifest.filter((index) => index.key.migrationEvidenceRef === 1)).toHaveLength(1);
  });
});
