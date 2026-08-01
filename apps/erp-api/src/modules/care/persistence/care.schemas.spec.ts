import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  CareAlumniCleanupTaskRecordSchema,
  type CareAlumniCleanupTaskRecord,
  CareAlumniConsentRecordSchema,
  type CareAlumniConsentRecord,
  CareCaseRecordSchema,
  CareOccasionPreferenceRecordSchema,
  type CareOccasionPreferenceRecord,
  CareOccasionTaskRecordSchema,
  type CareOccasionTaskRecord,
  CareTaskEvidenceRecordSchema,
  type CareCaseRecord,
  type CareTaskEvidenceRecord,
} from './care.schemas.js';

const mongoose = new Mongoose();
const CaseModel = mongoose.model<CareCaseRecord>('SpecCareCase', CareCaseRecordSchema);
const EvidenceModel = mongoose.model<CareTaskEvidenceRecord>(
  'SpecCareEvidence', CareTaskEvidenceRecordSchema,
);
const ConsentModel = mongoose.model<CareAlumniConsentRecord>(
  'SpecCareAlumniConsent', CareAlumniConsentRecordSchema,
);
const AlumniCleanupTaskModel = mongoose.model<CareAlumniCleanupTaskRecord>(
  'SpecCareAlumniCleanupTask',
  CareAlumniCleanupTaskRecordSchema,
);
const OccasionPreferenceModel = mongoose.model<CareOccasionPreferenceRecord>(
  'SpecCareOccasionPreference',
  CareOccasionPreferenceRecordSchema,
);
const OccasionTaskModel = mongoose.model<CareOccasionTaskRecord>(
  'SpecCareOccasionTask',
  CareOccasionTaskRecordSchema,
);

describe('Care 持久化契约', () => {
  it('离职案件使用严格业务日期、受控原因和 UTC 失效时刻', async () => {
    const valid = {
      id: 'care-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      employmentId: 'employment-001', separationType: 'voluntary_resignation',
      reasonCode: 'PERSONAL_REASON', lastWorkingDate: '2026-07-31',
      tenantTimeZone: 'Asia/Shanghai', accessDisableAt: new Date('2026-07-31T10:00:00.000Z'),
      status: 'draft', version: 1,
    };
    await expect(new CaseModel(valid).validate()).resolves.toBeUndefined();
    await expect(new CaseModel({
      ...valid, reasonCode: '自由文本原因',
    }).validate()).rejects.toThrow(/reasonCode/);
    await expect(new CaseModel({
      ...valid, lastWorkingDate: '2026/07/31',
    }).validate()).rejects.toThrow(/lastWorkingDate/);
  });

  it('进行中劳动关系案件、审批实例、单任务证据与活动校友目的有唯一约束', () => {
    const activeCase = CareCaseRecordSchema.indexes().find(
      ([key]) => key.tenantId === 1 && key.employmentId === 1,
    );
    expect(activeCase?.[1].unique).toBe(true);
    expect(activeCase?.[1].partialFilterExpression).toEqual({ status: { $in: [
      'draft', 'pending_approval', 'approved', 'clearing', 'ready', 'scheduled', 'executing',
    ] } });
    expect(CareCaseRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, approvalInstanceId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(CareTaskEvidenceRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, careCaseId: 1, taskCode: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(CareAlumniConsentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, personId: 1, purpose: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { status: 'active' } }),
    ]);
  });

  it('证据记录不接受任意任务编码', async () => {
    await expect(new EvidenceModel({
      id: 'record-001', tenantId: 'tenant-001', careCaseId: 'care-001',
      taskCode: 'self_reported_done', evidenceId: 'evidence-001', actorId: 'actor-001',
      occurredAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).rejects.toThrow(/taskCode/);
  });

  it('校友授权状态必须与撤回或到期时刻一致', async () => {
    const active = {
      id: 'consent-001', tenantId: 'tenant-001', personId: 'person-001',
      careCaseId: 'care-001', purpose: 'alumni_network', channels: ['email'],
      consentVersion: 'v1', consentEvidenceId: 'evidence-001',
      grantedAt: new Date('2026-07-21T00:00:00.000Z'),
      expiresAt: new Date('2027-07-21T00:00:00.000Z'),
      withdrawnAt: null, expiredAt: null, status: 'active', version: 1,
    };
    await expect(new ConsentModel(active).validate()).resolves.toBeUndefined();
    await expect(new ConsentModel({
      ...active, status: 'expired',
      expiredAt: new Date('2027-07-21T00:00:00.000Z'),
    }).validate()).resolves.toBeUndefined();
    await expect(new ConsentModel({
      ...active, status: 'expired',
      expiredAt: new Date('2027-07-20T23:59:59.000Z'),
    }).validate()).rejects.toThrow(/status/);
    await expect(new ConsentModel({
      ...active, status: 'withdrawn',
    }).validate()).rejects.toThrow(/status/);
  });

  it('校友清理任务自然键、证明摘要与状态组合失败关闭', async () => {
    expect(CareAlumniCleanupTaskRecordSchema.indexes()).toContainEqual([
      {
        tenantId: 1,
        consentId: 1,
        consentVersion: 1,
        consentPurpose: 1,
        targetCode: 1,
        policyVersion: 1,
      },
      expect.objectContaining({ unique: true }),
    ]);
    const valid = {
      id: 'A'.repeat(43),
      tenantId: 'tenant-001',
      consentId: 'consent-001',
      consentVersion: 2,
      consentPurpose: 'alumni_network',
      terminationReason: 'withdrawn',
      terminatedAt: new Date('2026-07-27T00:00:00.000Z'),
      sourceEventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6',
      targetCode: 'crm',
      policyVersion: 'privacy-v1',
      controlDigest: 'B'.repeat(43),
      maxAttempts: 3,
      proofRetentionDays: 2_555,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date('2026-07-27T00:00:00.000Z'),
      lockedAt: null,
      lockedBy: null,
      proofDigest: null,
      proofAction: null,
      proofStorage: null,
      proofCompletedAt: null,
      proofRetentionUntil: null,
      proofKeyId: null,
      lastErrorCode: null,
      version: 1,
    };
    await expect(new AlumniCleanupTaskModel(valid).validate()).resolves.toBeUndefined();
    await expect(new AlumniCleanupTaskModel({
      ...valid,
      status: 'completed',
    }).validate()).rejects.toThrow(/proofDigest/);
    await expect(new AlumniCleanupTaskModel({
      ...valid,
      status: 'pending',
      proofDigest: 'C'.repeat(43),
      proofAction: 'deleted',
      proofStorage: 'immutable_worm',
      proofCompletedAt: new Date('2026-07-27T00:01:00.000Z'),
      proofRetentionUntil: new Date('2033-07-27T00:01:00.000Z'),
      proofKeyId: 'proof-key-v1',
    }).validate()).rejects.toThrow(/proofDigest/);
    await expect(new AlumniCleanupTaskModel({
      ...valid,
      status: 'dispatching',
      lockedAt: null,
      lockedBy: 'worker-001',
    }).validate()).rejects.toThrow(/status/);
  });

  it('关怀偏好退订与任务终态证据必须保持组合一致', async () => {
    const preference = {
      id: 'preference-001',
      tenantId: 'tenant-001',
      personId: 'person-001',
      employeeId: 'employee-001',
      currentEmploymentId: 'employment-001',
      birthdayEnabled: true,
      anniversaryEnabled: false,
      preferredChannels: ['feishu'],
      unsubscribed: false,
      version: 1,
    };
    await expect(new OccasionPreferenceModel(preference).validate()).resolves.toBeUndefined();
    await expect(new OccasionPreferenceModel({
      ...preference,
      unsubscribed: true,
    }).validate()).rejects.toThrow(/unsubscribed/);
    const task = {
      id: 'care-task-001',
      tenantId: 'tenant-001',
      personId: 'person-001',
      employeeId: 'employee-001',
      employmentId: 'employment-001',
      occasionType: 'birthday',
      occurrenceYear: 2026,
      scheduledAt: new Date('2026-07-27T01:00:00.000Z'),
      templateCode: 'CARE_BIRTHDAY_V1',
      policyVersion: 'care-v1',
      preferredChannels: ['feishu'],
      sourceDigest: 's'.repeat(43),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date('2026-07-27T01:00:00.000Z'),
      lockedAt: null,
      lockedBy: null,
      denialCode: null,
      deliveryEvidenceId: null,
      deliveredAt: null,
      version: 1,
    };
    await expect(new OccasionTaskModel(task).validate()).resolves.toBeUndefined();
    await expect(new OccasionTaskModel({
      ...task,
      status: 'delivered',
    }).validate()).rejects.toThrow(/status/);
  });
});
