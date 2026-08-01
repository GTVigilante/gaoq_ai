import { describe, expect, it } from 'vitest';

import { buildPhaseFiveTreasuryMigrationIndexManifest } from
  './phase-5-treasury-migration-indexes.js';

describe('Phase 5 Treasury 迁移证据索引 v1', () => {
  it('只为资金账户追加租户内唯一迁移证据索引', () => {
    const manifest = buildPhaseFiveTreasuryMigrationIndexManifest();
    const serialized = JSON.stringify(manifest);
    expect(serialized).toContain('treasury_bank_accounts');
    expect(manifest.filter((index) => index.key.migrationEvidenceRef === 1)).toHaveLength(1);
    expect(serialized).toContain('partialFilterExpression');
  });
});
