import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import type { RecruitmentOnboardingBridgeService } from '../../recruitment/application/recruitment-onboarding-bridge.service.js';
import {
  createOnboardingInstance,
  recordOnboardingTaskEvidence,
  type OnboardingInstance,
} from '../domain/index.js';
import type { OnboardingOutboxWriter } from '../persistence/onboarding-outbox.writer.js';
import type {
  OnboardingInstanceRepository,
  OnboardingTaskEvidenceRepository,
} from '../persistence/onboarding.repositories.js';
import { OnboardingApplicationService } from './onboarding-application.service.js';

const SESSION = {} as ClientSession;
const NOW = new Date('2026-07-21T00:00:00.000Z');

const source = {
  offerId: 'offer-001', applicationId: 'application-001', candidateId: 'candidate-001',
  candidateDisplayName: '候选人甲', acceptanceEvidenceId: 'acceptance-001',
  signedEvidenceId: 'contract_archived-evidence', proposedStartDate: '2026-08-01',
  departmentId: 'department-001', jobLevelId: 'level-001',
};

function readyInstance(): OnboardingInstance {
  let current = createOnboardingInstance({
    id: 'onboarding-001', tenantId: 'tenant-001', offerId: source.offerId,
    applicationId: source.applicationId, candidateId: source.candidateId,
    acceptanceEvidenceId: source.acceptanceEvidenceId, signedEvidenceId: null,
    departmentId: source.departmentId, jobLevelId: source.jobLevelId,
    proposedStartDate: source.proposedStartDate,
  }, NOW);
  for (const taskCode of [
    'contract_archived', 'identity_verified', 'materials_verified',
    'org_assignment_verified', 'mandatory_training_completed',
  ] as const) {
    current = recordOnboardingTaskEvidence(current, {
      tenantId: 'tenant-001', expectedVersion: current.version, taskCode,
      evidenceId: `${taskCode}-evidence`, evidenceRecordId: `${taskCode}-record`,
      actorId: 'actor-001',
      ...(taskCode === 'org_assignment_verified' ? { orgPositionId: 'org-position-001' } : {}),
    }, NOW).instance;
  }
  return current;
}

function fixture(initial: OnboardingInstance | null = null) {
  const context = new TenantContextService();
  let stored = initial;
  const instances = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    findByOfferId: vi.fn().mockImplementation(() =>
      Promise.resolve(stored?.offerId === source.offerId ? stored : null)),
    insert: vi.fn().mockImplementation((value: OnboardingInstance) => {
      stored = value;
      return Promise.resolve();
    }),
    replace: vi.fn().mockImplementation((value: OnboardingInstance) => {
      stored = value;
      return Promise.resolve();
    }),
  };
  const evidence = { append: vi.fn().mockResolvedValue(undefined) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const recruitment = {
    getOnboardingSource: vi.fn().mockResolvedValue(source),
    markPreboarding: vi.fn().mockResolvedValue({ applicationId: source.applicationId, stage: 'preboarding' }),
    markHired: vi.fn().mockResolvedValue({ applicationId: source.applicationId, stage: 'hired' }),
  };
  const org = {
    validateOnboardingAssignment: vi.fn().mockResolvedValue({ verified: true }),
    establishEmploymentFromOnboarding: vi.fn().mockResolvedValue({
      employment: { id: 'employment-001' }, employeeId: 'employee-001',
      employeeNo: 'E2026000001', personId: 'person-001',
    }),
  };
  const idempotency = { execute: vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  ) };
  const service = new OnboardingApplicationService(
    idempotency as unknown as IdempotencyService,
    context,
    instances as unknown as OnboardingInstanceRepository,
    evidence as unknown as OnboardingTaskEvidenceRepository,
    outbox as unknown as OnboardingOutboxWriter,
    recruitment as unknown as RecruitmentOnboardingBridgeService,
    org as unknown as OrgApplicationService,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'onboarding-worker', actorType: 'service' as const, tenantId: 'tenant-001',
      roleCodes: [], departmentIds: [], traceId: 'trace-001',
      scopes: [
        'erp:onboarding:create', 'erp:onboarding:read', 'erp:onboarding:write_all',
        'erp:onboarding:task:complete', 'erp:onboarding:contract:attest',
        'erp:identity:onboarding:attest',
        'erp:knowledge:onboarding:attest', 'erp:onboarding:complete',
        'erp:onboarding:org:validate', 'erp:onboarding:employment:establish',
      ],
    },
  };
  return {
    service, context, trusted, instances, evidence, outbox, recruitment, org,
    get stored() { return stored; },
  };
}

describe('OnboardingApplicationService', () => {
  it('先落入职实例再通过招聘窄桥推进 preboarding', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () =>
      store.service.createFromOffer('offer-001', 'onboarding-create-001'),
    );
    expect(result.onboarding.status).toBe('in_progress');
    expect(store.instances.insert).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: 'offer-001' }), SESSION,
    );
    expect(store.recruitment.markPreboarding).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      { offerId: 'offer-001', onboardingInstanceId: result.onboarding.id },
    );
  });

  it('组织分配证据落库前必须由 Org 应用服务校验正式岗位', async () => {
    const store = fixture(createOnboardingInstance({
      id: 'onboarding-001', tenantId: 'tenant-001', offerId: source.offerId,
      applicationId: source.applicationId, candidateId: source.candidateId,
      acceptanceEvidenceId: source.acceptanceEvidenceId, signedEvidenceId: null,
      departmentId: source.departmentId, jobLevelId: source.jobLevelId,
      proposedStartDate: source.proposedStartDate,
    }, NOW));
    await store.context.run(store.trusted, () => store.service.recordTaskEvidence(
      'onboarding-001', 1, 'onboarding-task-001', {
        taskCode: 'org_assignment_verified', evidenceId: 'evidence-001',
        orgPositionId: 'org-position-001',
      },
    ));
    expect(store.org.validateOnboardingAssignment).toHaveBeenCalledWith({
      departmentId: 'department-001', orgPositionId: 'org-position-001',
      jobLevelId: 'level-001',
    });
    expect(store.evidence.append).toHaveBeenCalledWith(
      expect.objectContaining({ taskCode: 'org_assignment_verified' }), SESSION,
    );
  });

  it('完成 Saga 依次建立 Employment、固化 completed 并推进招聘 hired', async () => {
    const current = readyInstance();
    const store = fixture(current);
    const result = await store.context.run(store.trusted, () => store.service.complete(
      current.id, current.version, 'onboarding-complete-001',
    ));
    expect(result.onboarding).toMatchObject({ status: 'completed', employmentId: 'employment-001' });
    expect(store.org.establishEmploymentFromOnboarding).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      expect.objectContaining({
        onboardingInstanceId: current.id,
        effectiveFrom: '2026-08-01',
        orgPositionId: 'org-position-001',
      }),
    );
    expect(store.recruitment.markHired).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      expect.objectContaining({ employmentId: 'employment-001' }),
    );
    expect(store.stored?.version).toBe(8);
  });
});
