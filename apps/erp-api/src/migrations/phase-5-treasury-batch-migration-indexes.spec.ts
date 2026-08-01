import { describe, expect, it } from 'vitest';

import { buildPhaseFiveTreasuryBatchMigrationIndexManifest } from
  './phase-5-treasury-batch-migration-indexes.js';

describe('Phase 5 Treasury 付款批次迁移证据索引 v2', () => {
  it('只为付款批次追加租户内唯一迁移证据索引', () => {
    const manifest = buildPhaseFiveTreasuryBatchMigrationIndexManifest();
    const serialized = JSON.stringify(manifest);
    expect(manifest).toHaveLength(1);
    expect(serialized).toContain('treasury_disbursement_batches');
    expect(serialized).not.toContain('treasury_bank_accounts');
    expect(manifest.filter((index) => index.key.migrationEvidenceRef === 1)).toHaveLength(1);
    expect(serialized).toContain('partialFilterExpression');
  });
});
