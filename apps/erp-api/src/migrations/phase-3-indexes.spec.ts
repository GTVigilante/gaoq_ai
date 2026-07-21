import { describe, expect, it } from 'vitest';

import { buildPhaseThreeIndexManifest } from './phase-3-indexes.js';

describe('Phase 3 索引迁移清单', () => {
  it('覆盖招聘、eSign、组织劳动关系与入职集合', () => {
    const collections = new Set(buildPhaseThreeIndexManifest().map((item) => item.collection));
    for (const collection of [
      'recruitment_candidates', 'recruitment_offers', 'integration_esign_flows',
      'org_persons', 'org_employments', 'org_employee_number_sequences',
      'onboarding_instances', 'onboarding_task_evidence',
    ]) expect(collections.has(collection)).toBe(true);
  });

  it('清单包含关键业务唯一约束且集合内名称唯一', () => {
    const manifest = buildPhaseThreeIndexManifest();
    const identities = manifest.map((item) => `${item.collection}:${item.name}`);
    expect(new Set(identities).size).toBe(identities.length);
    const onboardingOffer = manifest.find((item) =>
      item.collection === 'onboarding_instances' && item.key.offerId === 1,
    );
    expect(onboardingOffer?.options.unique).toBe(true);
    const currentEmployment = manifest.find((item) =>
      item.collection === 'org_employments' && item.key.personId === 1 &&
      Object.keys(item.key).length === 2,
    );
    expect(currentEmployment?.options.unique).toBe(true);
    expect(currentEmployment?.options.partialFilterExpression).toEqual({ effectiveTo: null });
  });
});
