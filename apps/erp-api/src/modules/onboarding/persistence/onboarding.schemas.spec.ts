import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OnboardingInstanceRecordSchema,
  OnboardingTaskEvidenceRecordSchema,
  type OnboardingInstanceRecord,
  type OnboardingTaskEvidenceRecord,
} from './onboarding.schemas.js';

const mongoose = new Mongoose();
const InstanceModel = mongoose.model<OnboardingInstanceRecord>(
  'SpecOnboardingInstance', OnboardingInstanceRecordSchema,
);
const EvidenceModel = mongoose.model<OnboardingTaskEvidenceRecord>(
  'SpecOnboardingEvidence', OnboardingTaskEvidenceRecordSchema,
);

function instance(): Record<string, unknown> {
  return {
    id: 'onboarding-001', tenantId: 'tenant-001', offerId: 'offer-001',
    applicationId: 'application-001', candidateId: 'candidate-001',
    acceptanceEvidenceId: 'acceptance-001', signedEvidenceId: null,
    identityEvidenceId: null, materialsEvidenceId: null,
    orgAssignmentEvidenceId: null, trainingEvidenceId: null,
    departmentId: 'department-001', jobLevelId: 'level-001', orgPositionId: null,
    proposedStartDate: '2026-08-01', status: 'in_progress',
    completionEvidenceId: null, employmentId: null, version: 1,
  };
}

describe('Onboarding 持久化契约', () => {
  it('入职实例和任务证据通过严格枚举与日期校验', async () => {
    await expect(new InstanceModel(instance()).validate()).resolves.toBeUndefined();
    await expect(new InstanceModel({
      ...instance(), proposedStartDate: '2026/08/01',
    }).validate()).rejects.toThrow(/proposedStartDate/);
    await expect(new EvidenceModel({
      id: 'record-001', tenantId: 'tenant-001', onboardingInstanceId: 'onboarding-001',
      taskCode: 'identity_verified', evidenceId: 'evidence-001', actorId: 'actor-001',
      occurredAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).resolves.toBeUndefined();
    await expect(new EvidenceModel({
      id: 'record-002', tenantId: 'tenant-001', onboardingInstanceId: 'onboarding-001',
      taskCode: 'self_reported_complete', evidenceId: 'evidence-002', actorId: 'actor-001',
      occurredAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).rejects.toThrow(/taskCode/);
  });

  it('Offer、申请和单任务证据均有租户内唯一索引', () => {
    expect(OnboardingInstanceRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, offerId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(OnboardingInstanceRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, applicationId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(OnboardingTaskEvidenceRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, onboardingInstanceId: 1, taskCode: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
