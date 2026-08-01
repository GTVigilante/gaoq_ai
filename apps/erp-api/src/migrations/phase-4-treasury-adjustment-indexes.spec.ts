import { describe, expect, it } from 'vitest';

import {
  buildPhaseFourTreasuryAdjustmentIndexManifest,
} from './phase-4-treasury-adjustment-indexes.js';

describe('Phase 4 Treasury 工资调整索引迁移', () => {
  it('只追加可信租户开头的工资调整来源唯一索引', () => {
    const manifest = buildPhaseFourTreasuryAdjustmentIndexManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      collection: 'treasury_disbursement_batches',
      key: { tenantId: 1, adjustmentSourceId: 1 },
      options: {
        unique: true,
        partialFilterExpression: { adjustmentSourceId: { $type: 'string' } },
      },
    });
  });
});
