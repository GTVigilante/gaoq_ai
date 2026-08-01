import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CandidateApplication, RecruitmentOffer } from '../domain/index.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentCandidateRepository,
  RecruitmentOfferRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentOnboardingBridgeService } from './recruitment-onboarding-bridge.service.js';

const SESSION = {} as ClientSession;
const NOW = '2026-07-21T00:00:00.000Z';

function application(stage: CandidateApplication['stage'] = 'offer_accepted'): CandidateApplication {
  return {
    id: 'application-001',
    tenantId: 'tenant-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    consentEvidenceId: 'consent-001',
    sourceChannel: 'portal',
    stage,
    completedInterviewId: 'interview-001',
    offerId: 'offer-001',
    acceptanceEvidenceId: 'acceptance-001',
    onboardingInstanceId: stage === 'offer_accepted' ? null : 'onboarding-001',
    employmentId: stage === 'hired' ? 'employment-001' : null,
    version: stage === 'offer_accepted' ? 6 : stage === 'preboarding' ? 7 : 8,
    appliedAt: NOW,
    endedAt: stage === 'hired' ? NOW : null,
    updatedAt: NOW,
  };
}

function offer(status: 'accepted' | 'signed' = 'accepted'): RecruitmentOffer {
  return {
    id: 'offer-001',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    status,
    terms: {
      currency: 'CNY',
      monthlyBaseSalaryMinor: 1_000_000,
      salaryMonths: 13,
      annualVariableTargetMinor: 0,
      signingBonusMinor: 0,
      proposedStartDate: '2026-08-01',
      probationMonths: 3,
      employmentType: 'full_time',
      workLocation: '上海',
      benefitsSummary: '受保护内容',
    },
    expiresAt: '2026-09-01T00:00:00.000Z',
    retentionExpiresAt: '2032-09-01T00:00:00.000Z',
    approvalInstanceId: 'approval-001',
    approvalHistoryId: null,
    sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001',
    acceptanceEvidenceId: 'acceptance-001',
    esignFlowId: status === 'signed' ? 'esign-flow-001' : null,
    signedEvidenceId: status === 'signed' ? 'signed-evidence-001' : null,
    version: status === 'signed' ? 7 : 6,
    createdBy: 'actor-001',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture(stage: CandidateApplication['stage'] = 'offer_accepted') {
  const context = new TenantContextService();
  const current = application(stage);
  const candidates = {
    findById: vi.fn().mockResolvedValue({
      id: 'candidate-001',
      tenantId: 'tenant-001',
      status: 'active',
      name: '候选人甲',
    }),
  };
  const applications = {
    findById: vi.fn().mockResolvedValue(current),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const stages = { append: vi.fn().mockResolvedValue(undefined) };
  const positions = {
    findById: vi.fn().mockResolvedValue({
      id: 'position-001',
      tenantId: 'tenant-001',
      departmentId: 'department-001',
      jobLevelId: 'level-001',
    }),
  };
  const offers = {
    findById: vi.fn().mockResolvedValue(
      offer(stage === 'offer_accepted' ? 'accepted' : 'signed'),
    ),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const idempotency = {
    execute: vi.fn().mockImplementation(
      async (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: ClientSession) => Promise<Record<string, unknown>>,
      ) => handler(SESSION),
    ),
  };
  const service = new RecruitmentOnboardingBridgeService(
    idempotency as unknown as IdempotencyService,
    context,
    candidates as unknown as RecruitmentCandidateRepository,
    applications as unknown as CandidateApplicationRepository,
    stages as unknown as CandidateApplicationStageRepository,
    positions as unknown as RecruitmentPositionRepository,
    offers as unknown as RecruitmentOfferRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'onboarding-worker',
      actorType: 'service' as const,
      tenantId: 'tenant-001',
      roleCodes: [],
      scopes: [
        'erp:onboarding:recruitment:read',
        'erp:onboarding:recruitment:advance',
      ],
      departmentIds: [],
      traceId: 'trace-001',
    },
  };
  return {
    service,
    context,
    trusted,
    candidates,
    applications,
    stages,
    positions,
    offers,
    outbox,
    idempotency,
  };
}

function readSource(store: ReturnType<typeof fixture>, offerId = 'offer-001') {
  return store.context.run(store.trusted, () => store.service.getOnboardingSource(offerId));
}

function markPreboarding(store: ReturnType<typeof fixture>) {
  return store.context.run(store.trusted, () => store.service.markPreboarding(
    'onboarding-preboarding-001',
    { offerId: 'offer-001', onboardingInstanceId: 'onboarding-001' },
  ));
}

function markHired(store: ReturnType<typeof fixture>) {
  return store.context.run(store.trusted, () => store.service.markHired(
    'onboarding-hired-001',
    {
      offerId: 'offer-001',
      onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'completion-001',
      employmentId: 'employment-001',
    },
  ));
}

const REFERENCE_MUTATIONS: readonly [
  string,
  {
    readonly offer?: Partial<RecruitmentOffer>;
    readonly application?: Partial<CandidateApplication>;
  },
][] = [
  ['Offer 租户', { offer: { tenantId: 'tenant-other' } }],
  ['Offer 标识', { offer: { id: 'offer-other' } }],
  ['申请租户', { application: { tenantId: 'tenant-other' } }],
  ['申请标识', { application: { id: 'application-other' } }],
  ['申请 Offer', { application: { offerId: 'offer-other' } }],
  ['申请候选人', { application: { candidateId: 'candidate-other' } }],
  ['申请职位', { application: { positionId: 'position-other' } }],
  ['申请面试', { application: { completedInterviewId: 'interview-other' } }],
  ['申请接受证据', { application: { acceptanceEvidenceId: 'acceptance-other' } }],
];

describe('RecruitmentOnboardingBridgeService', () => {
  it('只返回入职最小投影，不泄露 Offer 薪资与福利', async () => {
    const source = await readSource(fixture());
    expect(source).toMatchObject({
      candidateDisplayName: '候选人甲',
      acceptanceEvidenceId: 'acceptance-001',
      signedEvidenceId: null,
      proposedStartDate: '2026-08-01',
      departmentId: 'department-001',
      jobLevelId: 'level-001',
    });
    expect(source).not.toHaveProperty('monthlyBaseSalaryMinor');
    expect(source).not.toHaveProperty('benefitsSummary');
  });

  it('已签署 Offer 的入职投影携带签署证据，预入职候选人不再依赖 active 状态', async () => {
    const store = fixture('preboarding');
    store.candidates.findById.mockResolvedValue({
      id: 'candidate-001',
      tenantId: 'tenant-001',
      status: 'consent_withdrawn',
      name: '候选人甲',
    });
    await expect(readSource(store)).resolves.toMatchObject({
      signedEvidenceId: 'signed-evidence-001',
    });
  });

  it('读取与推进都拒绝缺少受信任工作流权限的调用', async () => {
    const store = fixture();
    const denied = {
      ...store.trusted,
      actor: { ...store.trusted.actor, scopes: [] },
    };
    await expect(store.context.run(denied, () =>
      store.service.getOnboardingSource('offer-001'),
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_TRUSTED_WORKFLOW_REQUIRED' },
    });
    await expect(store.context.run(denied, () => store.service.markPreboarding(
      'key-001',
      { offerId: 'offer-001', onboardingInstanceId: 'onboarding-001' },
    ))).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_TRUSTED_WORKFLOW_REQUIRED' },
    });
    expect(store.offers.findById).not.toHaveBeenCalled();
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('拒绝不存在、未接受或缺少接受证据的 Offer', async () => {
    const missing = fixture();
    missing.offers.findById.mockResolvedValue(null);
    await expect(readSource(missing)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_NOT_FOUND' },
    });

    const draft = fixture();
    draft.offers.findById.mockResolvedValue({ ...offer(), status: 'draft' });
    await expect(readSource(draft)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_OFFER_NOT_ACCEPTED' },
    });

    const noEvidence = fixture();
    noEvidence.offers.findById.mockResolvedValue({
      ...offer(),
      acceptanceEvidenceId: null,
    });
    await expect(readSource(noEvidence)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_ACCEPTANCE_EVIDENCE_REQUIRED' },
    });
  });

  it('拒绝声称已签署但缺少签署证据的 Offer', async () => {
    const store = fixture('preboarding');
    store.offers.findById.mockResolvedValue({
      ...offer('signed'),
      signedEvidenceId: null,
    });
    await expect(readSource(store)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
    });
  });

  it.each(REFERENCE_MUTATIONS)('拒绝%s引用不闭合', async (_label, mutation) => {
    const store = fixture();
    if (mutation.offer !== undefined) {
      store.offers.findById.mockResolvedValue({ ...offer(), ...mutation.offer });
    }
    if (mutation.application !== undefined) {
      store.applications.findById.mockResolvedValue({
        ...application(),
        ...mutation.application,
      });
    }
    await expect(readSource(store)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
    });
  });

  it('拒绝不存在或阶段不一致的候选申请', async () => {
    const missing = fixture();
    missing.applications.findById.mockResolvedValue(null);
    await expect(readSource(missing)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID' },
    });

    const invalidStage = fixture();
    invalidStage.applications.findById.mockResolvedValue(application('interview'));
    await expect(readSource(invalidStage)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID' },
    });
  });

  it.each([
    ['不存在', null],
    ['租户错误', {
      id: 'candidate-001', tenantId: 'tenant-other', status: 'active', name: '候选人甲',
    }],
    ['标识错误', {
      id: 'candidate-other', tenantId: 'tenant-001', status: 'active', name: '候选人甲',
    }],
    ['缺少姓名', {
      id: 'candidate-001', tenantId: 'tenant-001', status: 'active', name: null,
    }],
    ['未保持有效', {
      id: 'candidate-001', tenantId: 'tenant-001', status: 'consent_withdrawn', name: '候选人甲',
    }],
  ])('拒绝%s的入职候选人', async (_label, candidate) => {
    const store = fixture();
    store.candidates.findById.mockResolvedValue(candidate);
    await expect(readSource(store)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_CANDIDATE_INVALID' },
    });
  });

  it('拒绝不存在或引用错误的招聘职位', async () => {
    const missing = fixture();
    missing.positions.findById.mockResolvedValue(null);
    await expect(readSource(missing)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_NOT_FOUND' },
    });

    for (const invalid of [
      {
        id: 'position-001',
        tenantId: 'tenant-other',
        departmentId: 'department-001',
        jobLevelId: 'level-001',
      },
      {
        id: 'position-other',
        tenantId: 'tenant-001',
        departmentId: 'department-001',
        jobLevelId: 'level-001',
      },
    ]) {
      const store = fixture();
      store.positions.findById.mockResolvedValue(invalid);
      await expect(readSource(store)).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
      });
    }
  });

  it('用已落库 Onboarding 引用推进到 preboarding 并同步阶段事件与 Outbox', async () => {
    const store = fixture();
    await expect(markPreboarding(store)).resolves.toEqual({
      applicationId: 'application-001',
      stage: 'preboarding',
    });
    expect(store.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'preboarding', onboardingInstanceId: 'onboarding-001' }),
      6,
      SESSION,
    );
    expect(store.stages.append).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: 'onboarding-001', to: 'preboarding' }),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it.each(['preboarding', 'hired'] as const)(
    '重复推进已处于 %s 的同一 Onboarding 时返回既有终态',
    async (stage) => {
      await expect(markPreboarding(fixture(stage))).resolves.toEqual({
        applicationId: 'application-001',
        stage,
      });
    },
  );

  it('拒绝把已推进申请改绑到其他 Onboarding', async () => {
    const store = fixture('preboarding');
    store.applications.findById.mockResolvedValue({
      ...application('preboarding'),
      onboardingInstanceId: 'onboarding-other',
    });
    await expect(markPreboarding(store)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_INSTANCE_MISMATCH' },
    });
  });

  it('预入职推进拒绝无效 Offer、缺证据及不闭合申请', async () => {
    const missing = fixture();
    missing.offers.findById.mockResolvedValue(null);
    await expect(markPreboarding(missing)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_OFFER_INVALID' },
    });

    const noEvidence = fixture();
    noEvidence.offers.findById.mockResolvedValue({
      ...offer(),
      acceptanceEvidenceId: null,
    });
    await expect(markPreboarding(noEvidence)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
    });

    const noApplication = fixture();
    noApplication.applications.findById.mockResolvedValue(null);
    await expect(markPreboarding(noApplication)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_APPLICATION_INVALID' },
    });

    const brokenReference = fixture();
    brokenReference.applications.findById.mockResolvedValue({
      ...application(),
      candidateId: 'candidate-other',
    });
    await expect(markPreboarding(brokenReference)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
    });
  });

  it('预入职推进拒绝不处于 offer_accepted 的申请', async () => {
    const store = fixture();
    store.applications.findById.mockResolvedValue(application('screening'));
    await expect(markPreboarding(store)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_PREBOARDING_TRANSITION_INVALID' },
    });
  });

  it('只有已签 Offer 才能用完成证据推进 hired，并单独固化劳动关系引用', async () => {
    const store = fixture('preboarding');
    await expect(markHired(store)).resolves.toEqual({
      applicationId: 'application-001',
      stage: 'hired',
    });
    expect(store.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'hired', employmentId: 'employment-001' }),
      7,
      SESSION,
    );
    expect(store.stages.append).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: 'completion-001', to: 'hired' }),
      SESSION,
    );
  });

  it('重复完成同一劳动关系返回 hired，改绑其他劳动关系则拒绝', async () => {
    await expect(markHired(fixture('hired'))).resolves.toEqual({
      applicationId: 'application-001',
      stage: 'hired',
    });

    const mismatch = fixture('hired');
    mismatch.applications.findById.mockResolvedValue({
      ...application('hired'),
      employmentId: 'employment-other',
    });
    await expect(markHired(mismatch)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_EMPLOYMENT_MISMATCH' },
    });
  });

  it('完成入职拒绝 Onboarding 不匹配或申请阶段错误', async () => {
    const onboardingMismatch = fixture('preboarding');
    onboardingMismatch.applications.findById.mockResolvedValue({
      ...application('preboarding'),
      onboardingInstanceId: 'onboarding-other',
    });
    await expect(markHired(onboardingMismatch)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_INSTANCE_MISMATCH' },
    });

    const invalidStage = fixture('preboarding');
    invalidStage.applications.findById.mockResolvedValue({
      ...application('offer_accepted'),
      onboardingInstanceId: 'onboarding-001',
    });
    await expect(markHired(invalidStage)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_HIRED_TRANSITION_INVALID' },
    });
  });

  it('完成入职拒绝仅被接受的 Offer 以及缺少签署证据的伪签署 Offer', async () => {
    const accepted = fixture('preboarding');
    accepted.offers.findById.mockResolvedValue(offer('accepted'));
    await expect(markHired(accepted)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_OFFER_INVALID' },
    });

    const noSignedEvidence = fixture('preboarding');
    noSignedEvidence.offers.findById.mockResolvedValue({
      ...offer('signed'),
      signedEvidenceId: null,
    });
    await expect(markHired(noSignedEvidence)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_ONBOARDING_SOURCE_REFERENCE_INVALID' },
    });
  });
});
