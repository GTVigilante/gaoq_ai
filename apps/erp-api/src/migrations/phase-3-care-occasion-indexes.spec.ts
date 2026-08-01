import { describe, expect, it } from 'vitest';

import { buildPhaseThreeCareOccasionIndexManifest } from './phase-3-care-occasion-indexes.js';
import { buildPhaseThreeIndexManifest } from './phase-3-indexes.js';

describe('Phase 3 关怀周年追加索引迁移', () => {
  it('只持有新增关怀集合与 Person 生日盲索引', () => {
    const manifest = buildPhaseThreeCareOccasionIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'care_occasion_preferences',
      'care_occasion_tasks',
      'care_occasion_tenants',
      'org_persons',
    ]));
    expect(manifest.filter((item) => item.collection === 'org_persons')).toHaveLength(2);
  });

  it('固化自然幂等键、到期扫描、锁恢复、送达证据和租户注册约束', () => {
    const manifest = buildPhaseThreeCareOccasionIndexManifest();
    expect(manifest.some((item) =>
      item.collection === 'care_occasion_tasks' &&
      item.key.employeeId === 1 &&
      item.key.occasionType === 1 &&
      item.key.occurrenceYear === 1 &&
      item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'care_occasion_tasks' &&
      item.key.status === 1 &&
      item.key.nextAttemptAt === 1,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'care_occasion_tasks' &&
      item.key.lockedAt === 1,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'care_occasion_tasks' &&
      item.key.deliveryEvidenceId === 1 &&
      item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'care_occasion_tenants' &&
      item.key.tenantId === 1 &&
      item.options.unique === true,
    )).toBe(true);
  });

  it('历史 Phase 3 清单不吸收新生日索引，避免已发布 checksum 漂移', () => {
    expect(buildPhaseThreeIndexManifest().some((item) =>
      item.collection === 'org_persons' &&
      (item.key.birthdayEvidenceId === 1 || item.key.birthdayBlindIndexes === 1),
    )).toBe(false);
  });
});
