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
    id: 'application-001', tenantId: 'tenant-001', candidateId: 'candidate-001',
    positionId: 'position-001', consentEvidenceId: 'consent-001', sourceChannel: 'portal',
    stage, completedInterviewId: 'interview-001', offerId: 'offer-001',
    acceptanceEvidenceId: 'acceptance-001',
    onboardingInstanceId: stage === 'offer_accepted' ? null : 'onboarding-001',
    employmentId: stage === 'hired' ? 'employment-001' : null,
    version: stage === 'offer_accepted' ? 6 : stage === 'preboarding' ? 7 : 8,
    appliedAt: NOW, endedAt: stage === 'hired' ? NOW : null, updatedAt: NOW,
  };
}

function offer(): RecruitmentOffer {
  return {
    id: 'offer-001', tenantId: 'tenant-001', applicationId: 'application-001',
    candidateId: 'candidate-001', positionId: 'position-001',
    completedInterviewId: 'interview-001', status: 'accepted',
    terms: {
      currency: 'CNY', monthlyBaseSalaryMinor: 1_000_000, salaryMonths: 13,
      annualVariableTargetMinor: 0, signingBonusMinor: 0, proposedStartDate: '2026-08-01',
      probationMonths: 3, employmentType: 'full_time', workLocation: '上海',
      benefitsSummary: '受保护内容',
    },
    expiresAt: '2026-09-01T00:00:00.000Z', retentionExpiresAt: '2032-09-01T00:00:00.000Z',
    approvalInstanceId: 'approval-001', approvalHistoryId: null, sendRequestId: 'send-001',
    sentEvidenceId: 'sent-001', acceptanceEvidenceId: 'acceptance-001',
    esignFlowId: null, signedEvidenceId: null, version: 6, createdBy: 'actor-001',
    createdAt: NOW, updatedAt: NOW,
  };
}

function fixture(stage: CandidateApplication['stage'] = 'offer_accepted') {
  const context = new TenantContextService();
  const current = application(stage);
  const candidates = { findById: vi.fn().mockResolvedValue({
    id: 'candidate-001', tenantId: 'tenant-001', status: 'active', name: '候选人甲',
  }) };
  const applications = {
    findById: vi.fn().mockResolvedValue(current),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const stages = { append: vi.fn().mockResolvedValue(undefined) };
  const positions = { findById: vi.fn().mockResolvedValue({
    id: 'position-001', departmentId: 'department-001', jobLevelId: 'level-001',
  }) };
  const offers = { findById: vi.fn().mockResolvedValue(offer()) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const idempotency = { execute: vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  ) };
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
      actorId: 'onboarding-worker', actorType: 'service' as const, tenantId: 'tenant-001',
      roleCodes: [], scopes: [
        'erp:onboarding:recruitment:read', 'erp:onboarding:recruitment:advance',
      ], departmentIds: [], traceId: 'trace-001',
    },
  };
  return { service, context, trusted, applications, stages, outbox };
}

describe('RecruitmentOnboardingBridgeService', () => {
  it('只返回入职最小投影，不泄露 Offer 薪资与福利', async () => {
    const store = fixture();
    const source = await store.context.run(store.trusted, () =>
      store.service.getOnboardingSource('offer-001'),
    );
    expect(source).toMatchObject({
      candidateDisplayName: '候选人甲', proposedStartDate: '2026-08-01',
      departmentId: 'department-001', jobLevelId: 'level-001',
    });
    expect(source).not.toHaveProperty('monthlyBaseSalaryMinor');
    expect(source).not.toHaveProperty('benefitsSummary');
  });

  it('用已落库 Onboarding 引用推进到 preboarding 并同步写阶段事件和 Outbox', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () => store.service.markPreboarding(
      'onboarding-preboarding-001',
      { offerId: 'offer-001', onboardingInstanceId: 'onboarding-001' },
    ));
    expect(result.stage).toBe('preboarding');
    expect(store.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'preboarding', onboardingInstanceId: 'onboarding-001' }),
      6,
      SESSION,
    );
    expect(store.stages.append).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it('只有已绑定同一 Onboarding 的预入职申请可以进入 hired', async () => {
    const store = fixture('preboarding');
    const result = await store.context.run(store.trusted, () => store.service.markHired(
      'onboarding-hired-001',
      {
        offerId: 'offer-001', onboardingInstanceId: 'onboarding-001',
        onboardingCompletionEvidenceId: 'completion-001', employmentId: 'employment-001',
      },
    ));
    expect(result.stage).toBe('hired');
    expect(store.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'hired', employmentId: 'employment-001' }),
      7,
      SESSION,
    );
  });
});
