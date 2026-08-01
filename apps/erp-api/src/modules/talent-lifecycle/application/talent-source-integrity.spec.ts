import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { CareTalentSourceService } from '../../care/application/care-talent-source.service.js';
import type {
  CareAlumniConsentRepository,
  CareCaseRepository,
} from '../../care/persistence/care.repositories.js';
import { OnboardingTalentSourceService } from '../../onboarding/application/onboarding-talent-source.service.js';
import type { OnboardingInstanceRepository } from '../../onboarding/persistence/onboarding.repositories.js';
import { OrgTalentSourceService } from '../../org/application/org-talent-source.service.js';
import type {
  EmployeeRepository,
  EmploymentRepository,
  PersonRepository,
} from '../../org/persistence/org.repositories.js';
import { RecruitmentTalentSourceService } from '../../recruitment/application/recruitment-talent-source.service.js';
import type {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentCandidateRepository,
  RecruitmentPositionRepository,
} from '../../recruitment/persistence/recruitment.repositories.js';

const tenantId = 'tenant-001';
const candidateId = 'candidate-001';
const personId = 'person-001';
const applicationId = 'application-001';
const positionId = 'position-001';
const employmentId = 'employment-001';
const employeeId = 'employee-001';
const careCaseId = 'care-case-001';
const occurredAt = '2026-07-28T00:00:00.000Z';

const person = Object.freeze({
  id: personId,
  tenantId,
  sourceCandidateId: candidateId,
  identityEvidenceId: 'identity-evidence-001',
  birthdayEvidenceId: null,
  birthdayAttestedAt: null,
  status: 'active' as const,
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const employee = Object.freeze({
  id: employeeId,
  tenantId,
  employeeNo: 'E0001',
  displayName: '员工甲',
  status: 'active' as const,
  departmentIds: Object.freeze(['department-001']),
  primaryDepartmentId: 'department-001',
  positionIds: Object.freeze([positionId]),
  jobLevelId: 'job-level-001',
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const employment = Object.freeze({
  id: employmentId,
  tenantId,
  personId,
  employeeId,
  onboardingInstanceId: 'onboarding-001',
  onboardingCompletionEvidenceId: 'completion-evidence-001',
  offerId: 'offer-001',
  signedEvidenceId: 'signed-evidence-001',
  terminationCareCaseId: null,
  terminationExecutionEvidenceId: null,
  terminationEvidenceId: null,
  status: 'active' as const,
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const candidate = Object.freeze({
  id: candidateId,
  tenantId,
  status: 'active' as const,
  name: '候选人甲',
  phone: '+8613800000000',
  email: null,
  consent: Object.freeze({
    evidenceId: 'consent-evidence-001',
    version: 'V1',
    purpose: 'recruitment',
    source: 'portal' as const,
    capturedAt: occurredAt,
    expiresAt: '2027-07-28T00:00:00.000Z',
    withdrawnAt: null,
  }),
  retentionExpiresAt: '2028-07-28T00:00:00.000Z',
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const application = Object.freeze({
  id: applicationId,
  tenantId,
  candidateId,
  positionId,
  consentEvidenceId: 'consent-evidence-001',
  sourceChannel: 'portal',
  stage: 'interview' as const,
  completedInterviewId: null,
  offerId: null,
  acceptanceEvidenceId: null,
  onboardingInstanceId: null,
  employmentId: null,
  version: 2,
  appliedAt: occurredAt,
  endedAt: null,
  updatedAt: occurredAt,
});

const position = Object.freeze({
  id: positionId,
  tenantId,
  requisitionId: 'requisition-001',
  title: '后端工程师',
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  location: '上海',
  headcount: 1,
  status: 'open' as const,
  version: 2,
  publishedAt: occurredAt,
  closedAt: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const stage = Object.freeze({
  applicationId,
  tenantId,
  from: 'screening' as const,
  to: 'interview' as const,
  actorId: 'actor-001',
  reasonCode: null,
  evidenceId: null,
  resultingVersion: 2,
  occurredAt,
});

const onboarding = Object.freeze({
  id: 'onboarding-001',
  tenantId,
  offerId: 'offer-001',
  applicationId,
  candidateId,
  acceptanceEvidenceId: 'acceptance-evidence-001',
  signedEvidenceId: 'signed-evidence-001',
  identityEvidenceId: null,
  materialsEvidenceId: null,
  orgAssignmentEvidenceId: null,
  trainingEvidenceId: null,
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  orgPositionId: null,
  proposedStartDate: '2026-08-01',
  status: 'in_progress' as const,
  completionEvidenceId: null,
  employmentId: null,
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const careCase = Object.freeze({
  id: careCaseId,
  tenantId,
  employeeId,
  employmentId,
  separationType: 'voluntary_resignation' as const,
  reasonCode: 'PERSONAL',
  lastWorkingDate: '2026-08-31',
  tenantTimeZone: 'Asia/Shanghai',
  accessDisableAt: '2026-08-31T10:00:00.000Z',
  status: 'clearing' as const,
  approvalInstanceId: 'approval-001',
  handoverEvidenceId: null,
  assetsEvidenceId: null,
  financeEvidenceId: null,
  retentionEvidenceId: null,
  executionEvidenceId: null,
  orgTerminationEvidenceId: null,
  version: 3,
  createdAt: occurredAt,
  updatedAt: occurredAt,
});

const alumniConsent = Object.freeze({
  id: 'alumni-consent-001',
  tenantId,
  personId,
  careCaseId,
  purpose: 'alumni_events' as const,
  channels: Object.freeze(['wechat'] as const),
  consentVersion: 'V1',
  consentEvidenceId: 'alumni-evidence-001',
  grantedAt: occurredAt,
  expiresAt: '2027-07-28T00:00:00.000Z',
  withdrawnAt: null,
  expiredAt: null,
  status: 'active' as const,
  version: 1,
});

function run<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
  scopes: readonly string[] = ['erp:talent-lifecycle:read'],
  departmentIds: readonly string[] = ['department-001'],
): Promise<T> {
  return context.run({
    tenant: { tenantId, source: 'access_token' },
    actor: {
      actorId: 'actor-001',
      actorType: 'user',
      tenantId,
      roleCodes: ['hr'],
      scopes,
      departmentIds,
      traceId: 'trace-talent-source-001',
    },
  }, operation);
}

function orgFixture() {
  const context = new TenantContextService();
  const persons = { findBySourceCandidateId: vi.fn().mockResolvedValue(person) };
  const employments = { findByPersonId: vi.fn().mockResolvedValue([employment]) };
  const employees = { findById: vi.fn().mockResolvedValue(employee) };
  const service = new OrgTalentSourceService(
    context,
    persons as unknown as PersonRepository,
    employments as unknown as EmploymentRepository,
    employees as unknown as EmployeeRepository,
  );
  return { context, persons, employments, employees, service };
}

function recruitmentFixture() {
  const context = new TenantContextService();
  const candidates = {
    findById: vi.fn().mockResolvedValue(candidate),
    findRecent: vi.fn().mockResolvedValue([candidate]),
  };
  const applications = { findByCandidateId: vi.fn().mockResolvedValue([application]) };
  const stages = { findByApplicationId: vi.fn().mockResolvedValue([stage]) };
  const positions = { findById: vi.fn().mockResolvedValue(position) };
  const service = new RecruitmentTalentSourceService(
    context,
    candidates as unknown as RecruitmentCandidateRepository,
    applications as unknown as CandidateApplicationRepository,
    stages as unknown as CandidateApplicationStageRepository,
    positions as unknown as RecruitmentPositionRepository,
  );
  return { context, candidates, applications, stages, positions, service };
}

function onboardingFixture() {
  const context = new TenantContextService();
  const instances = { findByCandidateId: vi.fn().mockResolvedValue([onboarding]) };
  const service = new OnboardingTalentSourceService(
    context,
    instances as unknown as OnboardingInstanceRepository,
  );
  return { context, instances, service };
}

function careFixture() {
  const context = new TenantContextService();
  const cases = { findByEmploymentIds: vi.fn().mockResolvedValue([careCase]) };
  const consents = { findByCareCaseIds: vi.fn().mockResolvedValue([alumniConsent]) };
  const service = new CareTalentSourceService(
    context,
    cases as unknown as CareCaseRepository,
    consents as unknown as CareAlumniConsentRepository,
  );
  return { context, cases, consents, service };
}

describe('人才全生命周期跨域来源完整性', () => {
  it('四个权威域查询口都在服务内二次校验读取 Scope', async () => {
    const org = orgFixture();
    const recruitment = recruitmentFixture();
    const onboardingStore = onboardingFixture();
    const care = careFixture();

    await expect(run(org.context, () => org.service.getByCandidateId(candidateId), []))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(
      recruitment.context,
      () => recruitment.service.get(candidateId),
      [],
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(
      onboardingStore.context,
      () => onboardingStore.service.getByCandidateId(candidateId),
      [],
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(
      care.context,
      () => care.service.getByEmployments({ personId, employments: [] }),
      [],
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('组织域只返回部门可见劳动关系并保持候选人到员工的引用闭包', async () => {
    const store = orgFixture();
    await expect(run(store.context, () => store.service.getByCandidateId(candidateId)))
      .resolves.toEqual({
        personId,
        personStatus: 'active',
        employments: [expect.objectContaining({
          id: employmentId,
          employeeId,
          employeeNo: 'E0001',
        })],
      });
    await expect(run(
      store.context,
      () => store.service.getByCandidateId(candidateId),
      ['erp:talent-lifecycle:read'],
      ['department-999'],
    )).resolves.toBeNull();
    await expect(run(
      store.context,
      () => store.service.getByCandidateId(candidateId),
      ['erp:talent-lifecycle:read', 'erp:talent-lifecycle:read_all'],
      [],
    )).resolves.toMatchObject({ personId, employments: [{ id: employmentId }] });
  });

  it('组织域对缺失记录与四类引用错位失败关闭', async () => {
    const missing = orgFixture();
    missing.persons.findBySourceCandidateId.mockResolvedValueOnce(null);
    await expect(run(missing.context, () => missing.service.getByCandidateId(candidateId)))
      .resolves.toBeNull();

    const invalidPerson = orgFixture();
    invalidPerson.persons.findBySourceCandidateId.mockResolvedValueOnce({
      ...person,
      sourceCandidateId: 'candidate-other',
    });
    await expect(run(
      invalidPerson.context,
      () => invalidPerson.service.getByCandidateId(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_PERSON_REFERENCE_INVALID');

    const invalidEmployment = orgFixture();
    invalidEmployment.employments.findByPersonId.mockResolvedValueOnce([{
      ...employment,
      personId: 'person-other',
    }]);
    await expect(run(
      invalidEmployment.context,
      () => invalidEmployment.service.getByCandidateId(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_EMPLOYMENT_REFERENCE_INVALID');

    const missingEmployee = orgFixture();
    missingEmployee.employees.findById.mockResolvedValueOnce(null);
    await expect(run(
      missingEmployee.context,
      () => missingEmployee.service.getByCandidateId(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_EMPLOYEE_REFERENCE_INVALID');

    const invalidEmployee = orgFixture();
    invalidEmployee.employees.findById.mockResolvedValueOnce({
      ...employee,
      id: 'employee-other',
    });
    await expect(run(
      invalidEmployee.context,
      () => invalidEmployee.service.getByCandidateId(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_EMPLOYEE_REFERENCE_INVALID');
  });

  it('组织域允许已建 Person 尚无劳动关系的受控空投影', async () => {
    const store = orgFixture();
    store.employments.findByPersonId.mockResolvedValueOnce([]);
    await expect(run(store.context, () => store.service.getByCandidateId(candidateId)))
      .resolves.toEqual({ personId, personStatus: 'active', employments: [] });
  });

  it('招聘域按部门裁剪申请、忽略列表竞态缺失并返回稳定窄投影', async () => {
    const store = recruitmentFixture();
    const result = await run(store.context, () => store.service.get(candidateId));
    expect(result).toMatchObject({
      candidateId,
      displayName: '候选人甲',
      applications: [{
        id: applicationId,
        positionId,
        stageHistory: [{ from: 'screening', to: 'interview' }],
      }],
    });

    await expect(run(
      store.context,
      () => store.service.get(candidateId),
      ['erp:talent-lifecycle:read'],
      ['department-999'],
    )).rejects.toMatchObject({
      response: { code: 'TALENT_LIFECYCLE_CANDIDATE_READ_DENIED' },
    });

    store.candidates.findById.mockResolvedValueOnce(null);
    await expect(run(store.context, () => store.service.listRecent(10))).resolves.toEqual([]);
  });

  it('招聘域区分详情缺失并允许 read_all 跨部门读取', async () => {
    const missing = recruitmentFixture();
    missing.candidates.findById.mockResolvedValueOnce(null);
    await expect(run(missing.context, () => missing.service.get(candidateId)))
      .rejects.toBeInstanceOf(NotFoundException);

    const all = recruitmentFixture();
    await expect(run(
      all.context,
      () => all.service.get(candidateId),
      ['erp:talent-lifecycle:read', 'erp:talent-lifecycle:read_all'],
      [],
    )).resolves.toMatchObject({ applications: [{ id: applicationId }] });
  });

  it('招聘域拒绝候选人、申请、职位和阶段事件的跨租户或错位引用', async () => {
    const invalidCandidate = recruitmentFixture();
    invalidCandidate.candidates.findById.mockResolvedValueOnce({
      ...candidate,
      tenantId: 'tenant-other',
    });
    await expect(run(
      invalidCandidate.context,
      () => invalidCandidate.service.get(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_CANDIDATE_REFERENCE_INVALID');

    const invalidApplication = recruitmentFixture();
    invalidApplication.applications.findByCandidateId.mockResolvedValueOnce([{
      ...application,
      candidateId: 'candidate-other',
    }]);
    await expect(run(
      invalidApplication.context,
      () => invalidApplication.service.get(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_APPLICATION_REFERENCE_INVALID');

    const missingPosition = recruitmentFixture();
    missingPosition.positions.findById.mockResolvedValueOnce(null);
    await expect(run(
      missingPosition.context,
      () => missingPosition.service.get(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_POSITION_REFERENCE_INVALID');

    const invalidPosition = recruitmentFixture();
    invalidPosition.positions.findById.mockResolvedValueOnce({
      ...position,
      id: 'position-other',
    });
    await expect(run(
      invalidPosition.context,
      () => invalidPosition.service.get(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_POSITION_REFERENCE_INVALID');

    const invalidStage = recruitmentFixture();
    invalidStage.stages.findByApplicationId.mockResolvedValueOnce([{
      ...stage,
      applicationId: 'application-other',
    }]);
    await expect(run(
      invalidStage.context,
      () => invalidStage.service.get(candidateId),
    )).rejects.toThrow('TALENT_LIFECYCLE_STAGE_REFERENCE_INVALID');
  });

  it('入职域按部门裁剪且拒绝候选人或租户错位实例', async () => {
    const store = onboardingFixture();
    await expect(run(store.context, () => store.service.getByCandidateId(candidateId)))
      .resolves.toEqual([expect.objectContaining({
        id: onboarding.id,
        applicationId,
        tasks: {
          contract_archived: 'completed',
          identity_verified: 'pending',
          materials_verified: 'pending',
          org_assignment_verified: 'pending',
          mandatory_training_completed: 'pending',
        },
      })]);
    await expect(run(
      store.context,
      () => store.service.getByCandidateId(candidateId),
      ['erp:talent-lifecycle:read'],
      [],
    )).resolves.toEqual([]);
    await expect(run(
      store.context,
      () => store.service.getByCandidateId(candidateId),
      ['erp:talent-lifecycle:read', 'erp:talent-lifecycle:read_all'],
      [],
    )).resolves.toHaveLength(1);

    store.instances.findByCandidateId.mockResolvedValueOnce([{
      ...onboarding,
      candidateId: 'candidate-other',
    }]);
    await expect(run(store.context, () => store.service.getByCandidateId(candidateId)))
      .rejects.toThrow('TALENT_LIFECYCLE_ONBOARDING_REFERENCE_INVALID');
  });

  it('Care 域只接受已授权劳动关系闭包并返回匹配自然人的授权', async () => {
    const store = careFixture();
    await expect(run(
      store.context,
      () => store.service.getByEmployments({
        personId,
        employments: [{ id: employmentId, employeeId }],
      }),
    )).resolves.toEqual({
      cases: [expect.objectContaining({
        id: careCaseId,
        employmentId,
        tasks: {
          handover_accepted: 'pending',
          assets_cleared: 'pending',
          finance_cleared: 'pending',
          data_retention_confirmed: 'pending',
        },
      })],
      alumniConsents: [expect.objectContaining({
        id: alumniConsent.id,
        personId,
        careCaseId,
      })],
    });
  });

  it('Care 域拒绝劳动关系、员工、案件、租户和自然人授权错位', async () => {
    const invalidCase = careFixture();
    invalidCase.cases.findByEmploymentIds.mockResolvedValueOnce([{
      ...careCase,
      employmentId: 'employment-other',
    }]);
    await expect(run(
      invalidCase.context,
      () => invalidCase.service.getByEmployments({
        personId,
        employments: [{ id: employmentId, employeeId }],
      }),
    )).rejects.toThrow('TALENT_LIFECYCLE_CARE_CASE_REFERENCE_INVALID');

    const invalidEmployee = careFixture();
    invalidEmployee.cases.findByEmploymentIds.mockResolvedValueOnce([{
      ...careCase,
      employeeId: 'employee-other',
    }]);
    await expect(run(
      invalidEmployee.context,
      () => invalidEmployee.service.getByEmployments({
        personId,
        employments: [{ id: employmentId, employeeId }],
      }),
    )).rejects.toThrow('TALENT_LIFECYCLE_CARE_CASE_REFERENCE_INVALID');

    const invalidConsent = careFixture();
    invalidConsent.consents.findByCareCaseIds.mockResolvedValueOnce([{
      ...alumniConsent,
      careCaseId: 'care-case-other',
    }]);
    await expect(run(
      invalidConsent.context,
      () => invalidConsent.service.getByEmployments({
        personId,
        employments: [{ id: employmentId, employeeId }],
      }),
    )).rejects.toThrow('TALENT_LIFECYCLE_ALUMNI_CONSENT_REFERENCE_INVALID');

    const invalidPerson = careFixture();
    await expect(run(
      invalidPerson.context,
      () => invalidPerson.service.getByEmployments({
        personId: null,
        employments: [{ id: employmentId, employeeId }],
      }),
    )).rejects.toThrow('TALENT_LIFECYCLE_ALUMNI_CONSENT_REFERENCE_INVALID');
  });
});
