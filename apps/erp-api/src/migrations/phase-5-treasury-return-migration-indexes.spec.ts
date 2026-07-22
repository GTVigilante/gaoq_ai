import { describe, expect, it } from 'vitest';

import { buildPhaseFiveTreasuryReturnMigrationIndexManifest } from
  './phase-5-treasury-return-migration-indexes.js';

describe('Phase 5 Treasury 银行回盘迁移证据索引 v3', () => {
  it('清单只包含回盘迁移证据唯一索引', () => {
    const manifest = buildPhaseFiveTreasuryReturnMigrationIndexManifest();
    const serialized = JSON.stringify(manifest);
    expect(manifest).toHaveLength(1);
    expect(serialized).toContain('treasury_bank_returns');
    expect(manifest[0]?.key.migrationEvidenceRef).toBe(1);
    expect(serialized).toContain('partialFilterExpression');
  });
});
