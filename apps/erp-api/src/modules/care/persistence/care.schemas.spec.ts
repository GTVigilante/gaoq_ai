import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  CareAlumniConsentRecordSchema,
  type CareAlumniConsentRecord,
  CareCaseRecordSchema,
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
});
