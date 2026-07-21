import { describe, expect, it } from 'vitest';

import { buildPhaseThreeCareIndexManifest } from './phase-3-care-indexes.js';

describe('Phase 3 Care 索引追加迁移', () => {
  it('覆盖离职案件、清算证据、校友授权和劳动关系终止引用', () => {
    const collections = new Set(buildPhaseThreeCareIndexManifest().map((item) => item.collection));
    for (const name of [
      'care_cases', 'care_task_evidence', 'care_alumni_consents', 'org_employments',
    ]) expect(collections.has(name)).toBe(true);
  });

  it('包含进行中案件、单任务证据、活动授权与 Care 终止引用唯一约束', () => {
    const manifest = buildPhaseThreeCareIndexManifest();
    for (const [collection, field] of [
      ['care_cases', 'employmentId'],
      ['care_task_evidence', 'taskCode'],
      ['care_alumni_consents', 'purpose'],
      ['org_employments', 'terminationCareCaseId'],
    ] as const) expect(manifest.some((item) =>
      item.collection === collection && item.key[field] === 1 && item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'org_employments' && item.key.employeeId === 1 &&
      Object.keys(item.key).length === 2 && item.options.unique === true,
    )).toBe(true);
  });
});
