import { describe, expect, it } from 'vitest';

import {
  buildPhaseThreeTalentLifecycleIndexManifest,
} from './phase-3-talent-lifecycle-indexes.js';

describe('Phase 3 人才全周期索引迁移', () => {
  it('保护候选人时间线、负责人待办和租户内主键', () => {
    const manifest = buildPhaseThreeTalentLifecycleIndexManifest();
    expect(new Set(manifest.map((item) => item.collection)))
      .toEqual(new Set(['talent_lifecycle_touchpoints']));
    expect(manifest.some((item) =>
      item.key.tenantId === 1 &&
      item.key.candidateId === 1 &&
      item.key.occurredAt === -1
    )).toBe(true);
    expect(manifest.some((item) =>
      item.key.tenantId === 1 &&
      item.key.status === 1 &&
      item.key.nextActionAt === 1 &&
      item.key.ownerActorId === 1
    )).toBe(true);
    const unique = manifest.find((item) =>
      Object.keys(item.key).length === 2 &&
      item.key.tenantId === 1 &&
      item.key.id === 1
    );
    expect(unique?.options.unique).toBe(true);
  });
});
