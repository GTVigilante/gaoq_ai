import { describe, expect, it } from 'vitest';

import {
  beginOnboardingProvisioning,
  completeOnboardingProvisioning,
  createOnboardingInstance,
  onboardingTaskStatuses,
  recordOnboardingTaskEvidence,
  type OnboardingInstance,
  type OnboardingTaskCode,
} from './onboarding.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

function instance(): OnboardingInstance {
  return createOnboardingInstance({
    id: 'onboarding-001', tenantId: 'tenant-001', offerId: 'offer-001',
    applicationId: 'application-001', candidateId: 'candidate-001',
    acceptanceEvidenceId: 'acceptance-001', signedEvidenceId: null,
    departmentId: 'department-001', jobLevelId: 'level-001',
    proposedStartDate: '2026-08-01',
  }, NOW);
}

function completeTask(
  current: OnboardingInstance,
  taskCode: OnboardingTaskCode,
): OnboardingInstance {
  return recordOnboardingTaskEvidence(current, {
    tenantId: 'tenant-001', expectedVersion: current.version, taskCode,
    evidenceId: `${taskCode}-evidence`, evidenceRecordId: `${taskCode}-record`,
    actorId: 'actor-001',
    ...(taskCode === 'org_assignment_verified' ? { orgPositionId: 'org-position-001' } : {}),
  }, NOW).instance;
}

describe('OnboardingInstance', () => {
  it('只保存任务引用并从任务状态推导就绪状态', () => {
    let current = instance();
    expect(onboardingTaskStatuses(current).contract_archived).toBe('pending');
    for (const code of [
      'contract_archived', 'identity_verified', 'materials_verified',
      'org_assignment_verified', 'mandatory_training_completed',
    ] as const) current = completeTask(current, code);
    expect(current.status).toBe('ready');
    expect(current.version).toBe(6);
    expect(current.orgPositionId).toBe('org-position-001');
  });

  it('拒绝会被 JavaScript 自动滚动的非法业务日期', () => {
    expect(() => createOnboardingInstance({
      id: 'onboarding-001', tenantId: 'tenant-001', offerId: 'offer-001',
      applicationId: 'application-001', candidateId: 'candidate-001',
      acceptanceEvidenceId: 'acceptance-001', signedEvidenceId: null,
      departmentId: 'department-001', jobLevelId: 'level-001',
      proposedStartDate: '2026-02-30',
    }, NOW)).toThrowError(/合法日期/);
  });

  it('任务证据一旦形成不得替换', () => {
    const current = completeTask(instance(), 'identity_verified');
    expect(() => recordOnboardingTaskEvidence(current, {
      tenantId: 'tenant-001', expectedVersion: 2, taskCode: 'identity_verified',
      evidenceId: 'different-evidence', evidenceRecordId: 'record-002', actorId: 'actor-001',
    }, NOW)).toThrowError(/不可替换/);
  });

  it('只有 ready 才能开始建档，并以同一完成证据绑定 Employment', () => {
    let current = instance();
    for (const code of [
      'contract_archived', 'identity_verified', 'materials_verified',
      'org_assignment_verified', 'mandatory_training_completed',
    ] as const) current = completeTask(current, code);
    const provisioning = beginOnboardingProvisioning(current, {
      tenantId: 'tenant-001', expectedVersion: 6, completionEvidenceId: 'completion-001',
    }, NOW);
    const completed = completeOnboardingProvisioning(provisioning, {
      tenantId: 'tenant-001', expectedVersion: 7,
      completionEvidenceId: 'completion-001', employmentId: 'employment-001',
    }, NOW);
    expect(completed).toMatchObject({
      status: 'completed', employmentId: 'employment-001', version: 8,
    });
  });
});
