import { describe, expect, it } from 'vitest';

import {
  CareDomainError,
  approveCareCase,
  beginCareExecution,
  completeCareExecution,
  createAlumniConsent,
  createOffboardingCase,
  recordCareTaskEvidence,
  scheduleCareExecution,
  submitCareCaseForApproval,
  withdrawAlumniConsent,
  type CareCase,
} from './care.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

function draft(): CareCase {
  return createOffboardingCase({
    id: 'care-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    employmentId: 'employment-001', separationType: 'voluntary_resignation',
    reasonCode: 'PERSONAL_REASON', lastWorkingDate: '2026-07-31',
    tenantTimeZone: 'Asia/Shanghai', accessDisableAt: '2026-07-31T10:00:00.000Z',
  }, NOW);
}

function approved(): CareCase {
  const submitted = submitCareCaseForApproval(draft(), {
    tenantId: 'tenant-001', expectedVersion: 1, approvalInstanceId: 'approval-001',
  }, NOW);
  return approveCareCase(submitted, {
    tenantId: 'tenant-001', expectedVersion: 2, approvalVerified: true,
  }, NOW);
}

function ready(): CareCase {
  let careCase = approved();
  for (const [taskCode, evidenceId] of [
    ['handover_accepted', 'evidence-001'],
    ['assets_cleared', 'evidence-002'],
    ['finance_cleared', 'evidence-003'],
    ['data_retention_confirmed', 'evidence-004'],
  ] as const) {
    careCase = recordCareTaskEvidence(careCase, {
      tenantId: 'tenant-001', expectedVersion: careCase.version,
      taskCode, evidenceId, evidenceRecordId: `record-${careCase.version}`,
      actorId: 'operator-001',
    }, NOW).careCase;
  }
  return careCase;
}

describe('Care 离职与校友授权领域', () => {
  it('权限失效时间必须落在租户时区的最后工作日', () => {
    expect(() => createOffboardingCase({
      id: 'care-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      employmentId: 'employment-001', separationType: 'contract_end',
      reasonCode: 'CONTRACT_END', lastWorkingDate: '2026-07-31',
      tenantTimeZone: 'Asia/Shanghai', accessDisableAt: '2026-07-31T16:00:00.000Z',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'CARE_ACCESS_DATE_MISMATCH' }));
  });

  it('审批只能由受信任结果推进，四类证据全部完成后才 ready', () => {
    const submitted = submitCareCaseForApproval(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, approvalInstanceId: 'approval-001',
    }, NOW);
    expect(() => approveCareCase(submitted, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalVerified: false,
    }, NOW)).toThrowError(expect.objectContaining({ code: 'CARE_APPROVAL_UNVERIFIED' }));
    expect(ready()).toMatchObject({ status: 'ready', version: 7 });
  });

  it('清算证据不可替换，相同证据重放不推进版本', () => {
    const current = approved();
    const first = recordCareTaskEvidence(current, {
      tenantId: 'tenant-001', expectedVersion: 3, taskCode: 'assets_cleared',
      evidenceId: 'evidence-001', evidenceRecordId: 'record-001', actorId: 'operator-001',
    }, NOW);
    const replay = recordCareTaskEvidence(first.careCase, {
      tenantId: 'tenant-001', expectedVersion: 4, taskCode: 'assets_cleared',
      evidenceId: 'evidence-001', evidenceRecordId: 'record-002', actorId: 'operator-001',
    }, NOW);
    expect(replay.evidence).toBeNull();
    expect(replay.careCase.version).toBe(4);
    expect(() => recordCareTaskEvidence(first.careCase, {
      tenantId: 'tenant-001', expectedVersion: 4, taskCode: 'assets_cleared',
      evidenceId: 'evidence-other', evidenceRecordId: 'record-003', actorId: 'operator-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'CARE_TASK_EVIDENCE_IMMUTABLE' }));
  });

  it('不到失效时刻不能执行，组织域未验证不能完成', () => {
    const scheduled = scheduleCareExecution(ready(), {
      tenantId: 'tenant-001', expectedVersion: 7,
    }, NOW);
    expect(() => beginCareExecution(scheduled, {
      tenantId: 'tenant-001', expectedVersion: 8, executionEvidenceId: 'execution-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'CARE_EXECUTION_TOO_EARLY' }));
    const executing = beginCareExecution(scheduled, {
      tenantId: 'tenant-001', expectedVersion: 8, executionEvidenceId: 'execution-001',
    }, new Date('2026-07-31T10:00:00.000Z'));
    expect(() => completeCareExecution(executing, {
      tenantId: 'tenant-001', expectedVersion: 9,
      orgTerminationEvidenceId: 'termination-001', orgTerminationVerified: false,
    }, NOW)).toThrowError(expect.objectContaining({ code: 'CARE_ORG_TERMINATION_UNVERIFIED' }));
  });

  it('校友授权必须在离职完成后、有明确目的渠道和期限，并可撤回', () => {
    expect(() => createAlumniConsent({
      id: 'consent-001', tenantId: 'tenant-001', personId: 'person-001',
      careCaseId: 'care-001', purpose: 'alumni_network', channels: ['email'],
      consentVersion: 'v1', grantedAt: NOW.toISOString(),
      consentEvidenceId: 'consent-evidence-001',
      expiresAt: '2027-07-21T00:00:00.000Z', careCompletedVerified: false,
    })).toThrowError(CareDomainError);
    const consent = createAlumniConsent({
      id: 'consent-001', tenantId: 'tenant-001', personId: 'person-001',
      careCaseId: 'care-001', purpose: 'alumni_network', channels: ['email', 'email'],
      consentVersion: 'v1', grantedAt: NOW.toISOString(),
      consentEvidenceId: 'consent-evidence-001',
      expiresAt: '2027-07-21T00:00:00.000Z', careCompletedVerified: true,
    });
    expect(consent.channels).toEqual(['email']);
    expect(withdrawAlumniConsent(consent, {
      tenantId: 'tenant-001', expectedVersion: 1,
    }, NOW)).toMatchObject({ status: 'withdrawn', version: 2 });
  });
});
