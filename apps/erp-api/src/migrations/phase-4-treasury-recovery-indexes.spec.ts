import { describe, expect, it } from 'vitest';

import { buildPhaseFourTreasuryRecoveryIndexManifest } from './phase-4-treasury-recovery-indexes.js';

describe('Phase 4 Treasury 恢复索引迁移', () => {
  it('只追加可信租户开头的恢复源唯一索引', () => {
    const manifest = buildPhaseFourTreasuryRecoveryIndexManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      collection: 'treasury_disbursement_batches',
      key: { tenantId: 1, recoverySourceBatchId: 1 },
      options: {
        unique: true,
        partialFilterExpression: { recoverySourceBatchId: { $type: 'string' } },
      },
    });
  });
});
