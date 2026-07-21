import { describe, expect, it } from 'vitest';

import { createEmployment } from './employment.js';
import { createPerson } from './person.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

describe('Person 与 Employment 分层', () => {
  it('Person 仅保存来源与身份核验证据引用', () => {
    const person = createPerson({
      id: 'person-001', tenantId: 'tenant-001', sourceCandidateId: 'candidate-001',
      identityEvidenceId: 'evidence-001',
    }, NOW);
    expect(person).toMatchObject({ status: 'active', version: 1 });
    expect(person).not.toHaveProperty('idCard');
    expect(person).not.toHaveProperty('phone');
  });

  it('Employment 独立引用 Person、Employee、Onboarding 与签署证据', () => {
    const employment = createEmployment({
      id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
      employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001',
      offerId: 'offer-001', signedEvidenceId: 'evidence-001',
      effectiveFrom: '2026-08-01',
    }, NOW);
    expect(employment).toMatchObject({ status: 'probation', effectiveTo: null, version: 1 });
  });
});
