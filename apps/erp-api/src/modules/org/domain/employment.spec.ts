import { describe, expect, it } from 'vitest';

import {
  createEmployment,
  terminateEmployment,
  transitionEmploymentStatus,
} from './employment.js';
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

  it('Care 可信执行关闭劳动关系并固化日期与证明引用', () => {
    const employment = createEmployment({
      id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
      employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001', offerId: 'offer-001',
      signedEvidenceId: 'signed-001', effectiveFrom: '2026-07-01',
    }, NOW);
    const terminated = terminateEmployment(employment, {
      tenantId: 'tenant-001', expectedVersion: 1, effectiveTo: '2026-07-31',
      careCaseId: 'care-001', executionEvidenceId: 'execution-001',
      terminationEvidenceId: 'termination-001',
    }, NOW);
    expect(terminated).toMatchObject({
      status: 'resigned', effectiveTo: '2026-07-31',
      terminationCareCaseId: 'care-001', version: 2,
    });
    expect(() => terminateEmployment(employment, {
      tenantId: 'tenant-001', expectedVersion: 1, effectiveTo: '2026-06-30',
      careCaseId: 'care-001', executionEvidenceId: 'execution-001',
      terminationEvidenceId: 'termination-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'EMPLOYMENT_END_BEFORE_START' }));
  });

  it('转正与停职状态迁移受控且离职不能走通用状态函数', () => {
    const probation = createEmployment({
      id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
      employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001', offerId: 'offer-001',
      signedEvidenceId: 'signed-001', effectiveFrom: '2026-07-01',
    }, NOW);
    const active = transitionEmploymentStatus(probation, {
      tenantId: 'tenant-001', expectedVersion: 1, status: 'active',
    }, NOW);
    expect(transitionEmploymentStatus(active, {
      tenantId: 'tenant-001', expectedVersion: 2, status: 'suspended',
    }, NOW)).toMatchObject({ status: 'suspended', version: 3 });
    expect(() => transitionEmploymentStatus(probation, {
      tenantId: 'tenant-001', expectedVersion: 1, status: 'suspended',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'EMPLOYMENT_STATUS_TRANSITION_INVALID' }));
  });
});
