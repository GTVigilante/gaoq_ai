import { describe, expect, it } from 'vitest';

import { buildPhaseFourTreasuryIndexManifest } from './phase-4-treasury-indexes.js';

describe('Phase 4 Treasury 索引追加迁移', () => {
  it('覆盖账户、支付指令、代发批次和银行回盘集合', () => {
    const collections = new Set(
      buildPhaseFourTreasuryIndexManifest().map((item) => item.collection),
    );
    for (const name of [
      'treasury_bank_accounts', 'treasury_payment_instructions',
      'treasury_disbursement_batches', 'treasury_bank_returns',
    ]) expect(collections.has(name)).toBe(true);
  });

  it('包含账号盲索引、运行批次序号和回盘摘要的租户级唯一约束', () => {
    const manifest = buildPhaseFourTreasuryIndexManifest();
    for (const [collection, field] of [
      ['treasury_bank_accounts', 'accountBlindIndexes'],
      ['treasury_disbursement_batches', 'batchSequence'],
      ['treasury_bank_returns', 'returnHash'],
    ] as const) expect(manifest.some((item) =>
      item.collection === collection && item.key.tenantId === 1 &&
      item.key[field] === 1 && item.options.unique === true,
    )).toBe(true);
  });
});
