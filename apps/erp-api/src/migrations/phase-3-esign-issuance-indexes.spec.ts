import { describe, expect, it } from 'vitest';

import {
  buildPhaseThreeESignIssuanceIndexManifest,
} from './phase-3-esign-issuance-indexes.js';

describe('Phase 3 eSign 发起索引迁移', () => {
  it('使用独立不可变清单保护请求、Offer 唯一性及恢复扫描', () => {
    const manifest = buildPhaseThreeESignIssuanceIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'integration_esign_issuance_requests',
    ]));
    const requestIdentity = manifest.find((item) =>
      item.key.tenantId === 1 && item.key.id === 1);
    expect(requestIdentity?.options.unique).toBe(true);
    const offerIdentity = manifest.find((item) =>
      item.key.tenantId === 1 && item.key.offerId === 1);
    expect(offerIdentity?.options.unique).toBe(true);
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: 'integration_esign_issuance_requests',
        key: { status: 1, nextAttemptAt: 1, createdAt: 1 },
      }),
      expect.objectContaining({
        collection: 'integration_esign_issuance_requests',
        key: { tenantId: 1, status: 1, id: -1 },
      }),
    ]));
  });
});
