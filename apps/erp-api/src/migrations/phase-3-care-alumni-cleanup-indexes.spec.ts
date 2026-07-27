import { describe, expect, it } from 'vitest';

import { buildPhaseThreeCareAlumniCleanupIndexManifest } from './phase-3-care-alumni-cleanup-indexes.js';
import { buildPhaseThreeIndexManifest } from './phase-3-indexes.js';

describe('Phase 3 校友下游清理追加索引迁移', () => {
  it('只包含新清理任务集合并固化自然键、扫描锁与证明唯一性', () => {
    const manifest = buildPhaseThreeCareAlumniCleanupIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(
      new Set(['care_alumni_cleanup_tasks']),
    );
    expect(manifest.some((item) =>
      item.key.consentId === 1 &&
      item.key.consentVersion === 1 &&
      item.key.consentPurpose === 1 &&
      item.key.targetCode === 1 &&
      item.key.policyVersion === 1 &&
      item.key.policyVersion === 1 &&
      item.options.unique === true)).toBe(true);
    expect(manifest.some((item) =>
      item.key.status === 1 &&
      item.key.nextAttemptAt === 1 &&
      item.key.lockedAt === 1)).toBe(true);
    expect(manifest.some((item) =>
      item.key.proofDigest === 1 &&
      item.options.unique === true)).toBe(true);
  });

  it('历史 Phase 3 清单不吸收新集合，避免已发布 checksum 漂移', () => {
    expect(buildPhaseThreeIndexManifest().some((item) =>
      item.collection === 'care_alumni_cleanup_tasks')).toBe(false);
  });
});
