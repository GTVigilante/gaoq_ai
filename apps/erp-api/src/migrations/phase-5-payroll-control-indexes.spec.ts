import { describe, expect, it } from 'vitest';

import { buildPhaseFivePayrollControlIndexManifest } from
  './phase-5-payroll-control-indexes.js';

describe('Phase 5 Payroll 控制迁移证据索引 v2', () => {
  it('不修改 v1 并为批准与锁定证据建立独立追加清单', () => {
    const manifest = buildPhaseFivePayrollControlIndexManifest();
    const serialized = JSON.stringify(manifest);
    for (const collection of [
      'payroll_period_approval_evidence', 'payroll_period_lock_evidence',
    ]) expect(serialized).toContain(collection);
    expect(manifest.filter((index) => index.key.migrationEvidenceRef === 1)).toHaveLength(2);
  });
});
