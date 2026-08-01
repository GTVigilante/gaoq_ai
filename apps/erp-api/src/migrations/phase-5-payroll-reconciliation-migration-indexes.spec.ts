import { describe, expect, it } from 'vitest';

import { buildPhaseFivePayrollReconciliationMigrationIndexManifest } from
  './phase-5-payroll-reconciliation-migration-indexes.js';

describe('Phase 5 Payroll 四方对账迁移证据索引 v4', () => {
  it('清单只包含四方对账迁移证据唯一索引', () => {
    const manifest = buildPhaseFivePayrollReconciliationMigrationIndexManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.collection).toBe('payroll_reconciliations');
    expect(manifest[0]?.key.migrationEvidenceRef).toBe(1);
  });
});
