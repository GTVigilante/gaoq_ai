import { describe, expect, it } from 'vitest';

import { buildPhaseFivePayrollMigrationIndexManifest } from
  './phase-5-payroll-migration-indexes.js';

describe('Phase 5 Payroll 迁移证据索引', () => {
  it('为最初四类 Payroll 迁移实体建立租户内唯一 WORM 引用', () => {
    const manifest = buildPhaseFivePayrollMigrationIndexManifest();
    const serialized = JSON.stringify(manifest);
    for (const collection of [
      'payroll_rule_packs', 'payroll_compensation_profiles',
      'payroll_periods', 'payroll_calculation_runs',
    ]) expect(serialized).toContain(collection);
    expect(manifest.filter((index) => index.key.migrationEvidenceRef === 1)).toHaveLength(4);
    expect(serialized).toContain('partialFilterExpression');
  });
});
