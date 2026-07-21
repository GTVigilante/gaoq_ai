import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import {
  applyRecruitmentOfferApprovalOutcome,
  createRecruitmentOffer,
  requestRecruitmentOfferSend,
  submitRecruitmentOffer,
  type CandidateApplicationStage,
  type RecruitmentOfferStatus,
} from '../domain/index.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  RecruitmentInterviewRepository,
  RecruitmentOfferRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentOfferService } from './recruitment-offer.service.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';
const OFFER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X3';
const APPROVAL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X4';
const SESSION = { id: 'session' } as unknown as ClientSession;
const NOW = new Date('2026-07-21T00:00:00.000Z');

const terms = {
  currency: 'CNY' as const, monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
  annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
  proposedStartDate: '2026-08-15', probationMonths: 3,
  employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
};

function application(stage: CandidateApplicationStage = 'interview') {
  const version: Record<CandidateApplicationStage, number> = {
    applied: 1, screening: 2, interview: 3, offer_approval: 4, offer_sent: 5,
    offer_accepted: 6, preboarding: 7, hired: 8, rejected: 4, withdrawn: 6,
  };
  return {
    id: APPLICATION_ID, tenantId: 'tenant-001', candidateId: CANDIDATE_ID,
    positionId: POSITION_ID, consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
    sourceChannel: 'portal', stage,
    completedInterviewId: ['offer_approval', 'offer_sent', 'offer_accepted', 'preboarding', 'hired']
      .includes(stage) ? INTERVIEW_ID : null,
    offerId: ['offer_sent', 'offer_accepted', 'preboarding', 'hired'].includes(stage) ? OFFER_ID : null,
    acceptanceEvidenceId: ['offer_accepted', 'preboarding', 'hired'].includes(stage)
      ? 'accept-evidence-001' : null,
    onboardingInstanceId: null, employmentId: null, version: version[stage],
    appliedAt: NOW.toISOString(), endedAt: null, updatedAt: NOW.toISOString(),
  };
}

function offer(status: RecruitmentOfferStatus = 'draft') {
  const draft = createRecruitmentOffer({
    id: OFFER_ID, tenantId: 'tenant-001', applicationId: APPLICATION_ID,
    candidateId: CANDIDATE_ID, positionId: POSITION_ID, completedInterviewId: INTERVIEW_ID,
    terms, expiresAt: new Date('2027-08-01T00:00:00.000Z'),
    retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
  }, NOW);
  if (status === 'draft') return draft;
  const pending = submitRecruitmentOffer(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
    approvalInstanceId: APPROVAL_ID,
  }, NOW);
  if (status === 'pending_approval') return pending;
  const approved = applyRecruitmentOfferApprovalOutcome(pending, {
    tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: APPROVAL_ID,
    outcome: status === 'rejected' ? 'rejected' : 'approved', approvalVerified: true,
  }, NOW);
  if (status === 'approved' || status === 'rejected') return approved;
  if (status === 'sending') return requestRecruitmentOfferSend(approved, {
    tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
  }, NOW);
  throw new Error(`测试暂不支持状态 ${status}`);
}

function fixture(options?: {
  readonly offerStatus?: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'sending';
  readonly applicationStage?: CandidateApplicationStage;
  readonly approvalStatus?: 'running' | 'approved' | 'rejected';
  readonly scopes?: readonly string[];
}) {
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'actor-001', tenantId: 'tenant-001', actorType: 'user' as const,
      roleCodes: [], scopes: options?.scopes ?? ['erp:recruitment:offer:sync_approval'],
      departmentIds: ['department-001'], traceId: 'trace-001',
    },
  };
  const context = {
    getRequired: vi.fn().mockReturnValue(trusted),
    getTenantRequired: vi.fn().mockReturnValue(trusted.tenant),
    getActorRequired: vi.fn().mockReturnValue(trusted.actor),
  };
  const approvals = {
    createInstance: vi.fn().mockResolvedValue({
      instance: { id: APPROVAL_ID, status: 'draft', version: 1 },
    }),
    submitInstance: vi.fn().mockResolvedValue({
      instance: { id: APPROVAL_ID, status: 'running', version: 2 },
    }),
    getInstanceStatusForRecruitmentOffer: vi.fn().mockResolvedValue({
      id: APPROVAL_ID, status: options?.approvalStatus ?? 'approved',
      templateCode: 'recruitment_offer', templateRevision: 1, riskLevel: 'R2', version: 3,
      submittedAt: NOW.toISOString(), completedAt: NOW.toISOString(),
    }),
  };
  const applications = {
    findById: vi.fn().mockResolvedValue(application(options?.applicationStage)),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const stages = { append: vi.fn().mockResolvedValue(undefined) };
  const positions = { findById: vi.fn().mockResolvedValue({
    id: POSITION_ID, departmentId: 'department-001', status: 'open',
  }) };
  const interviews = { findById: vi.fn().mockResolvedValue({
    id: INTERVIEW_ID, applicationId: APPLICATION_ID, status: 'completed',
  }) };
  const offers = {
    findById: vi.fn().mockResolvedValue(offer(options?.offerStatus)),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentOfferService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    approvals as unknown as ApprovalApplicationService,
    applications as unknown as CandidateApplicationRepository,
    stages as unknown as CandidateApplicationStageRepository,
    positions as unknown as RecruitmentPositionRepository,
    interviews as unknown as RecruitmentInterviewRepository,
    offers as unknown as RecruitmentOfferRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return { service, execute, approvals, applications, stages, offers, outbox };
}

describe('RecruitmentOfferService', () => {
  it('只有该申请已完成面试才能创建加密 Offer 聚合', async () => {
    const store = fixture();
    const result = await store.service.create(APPLICATION_ID, 3, 'offer-create-key-001', {
      completedInterviewId: INTERVIEW_ID, terms,
      expiresAt: '2027-08-01T00:00:00.000Z',
      retentionExpiresAt: '2033-08-01T00:00:00.000Z',
    });
    expect(store.offers.insert).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: APPLICATION_ID, completedInterviewId: INTERVIEW_ID,
      status: 'draft', terms,
    }), SESSION);
    expect(result.offer).not.toHaveProperty('terms');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toMatch(/标准福利计划|3000000/u);
  });

  it('提交时用 Offer 专用 R2 模板并原子推进申请到 offer_approval', async () => {
    const store = fixture();
    const result = await store.service.submit(OFFER_ID, 1, 'offer-submit-key-001');
    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      expect.stringMatching(/^recruitment:[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({ templateCode: 'recruitment_offer' }),
    );
    const request = store.approvals.createInstance.mock.calls[0]?.[1] as unknown as {
      readonly formData: Record<string, unknown>;
    };
    expect(request.formData).toMatchObject({
      offer_id: OFFER_ID, monthly_base_salary_minor: 3_000_000,
      benefits_summary: '标准福利计划',
    });
    expect(store.applications.replace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'offer_approval', completedInterviewId: INTERVIEW_ID, version: 4,
    }), 3, SESSION);
    expect(result.offer).toMatchObject({ status: 'pending_approval', version: 2 });
  });

  it('审批未终结时失败关闭，拒绝客户端上报 outcome', async () => {
    const store = fixture({ offerStatus: 'pending_approval', approvalStatus: 'running' });
    await expect(store.service.syncApproval(OFFER_ID, 2, 'offer-sync-key-001'))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_APPROVAL_NOT_TERMINAL' } });
    expect(store.offers.replace).not.toHaveBeenCalled();
  });

  it('审批通过后发送接口只创建 sending 意图，不伪造投递事实', async () => {
    const store = fixture({ offerStatus: 'approved', applicationStage: 'offer_approval' });
    const result = await store.service.requestSend(OFFER_ID, 3, 'offer-send-key-001');
    expect(result.offer).toMatchObject({ status: 'sending', version: 4 });
    expect(result.offer.sentEvidenceId).toBeNull();
    expect(store.applications.replace).not.toHaveBeenCalled();
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string;
      readonly payload: Readonly<Record<string, unknown>>;
    };
    expect(event).toMatchObject({
      type: 'recruitment.offer.send_requested',
      payload: { status: 'sending', sentEvidenceId: null },
    });
    expect(store.outbox.append.mock.calls[0]?.[1]).toBe(SESSION);
  });

  it('只有 Integration 专用 Scope 与可信回执才能推进 Offer 和申请', async () => {
    const denied = fixture({ offerStatus: 'sending', applicationStage: 'offer_approval', scopes: [] });
    await expect(denied.service.recordSentForIntegration(
      OFFER_ID, 4, 'offer-delivery-key-001', {
        sendRequestId: 'send-request-001', sentEvidenceId: 'sent-evidence-001',
      },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_TRUSTED_WORKFLOW_REQUIRED' } });
    const store = fixture({
      offerStatus: 'sending', applicationStage: 'offer_approval',
      scopes: ['erp:integration:offer:deliver'],
    });
    const result = await store.service.recordSentForIntegration(
      OFFER_ID, 4, 'offer-delivery-key-002', {
        sendRequestId: 'send-request-001', sentEvidenceId: 'sent-evidence-001',
      },
    );
    expect(result.offer).toMatchObject({ status: 'sent', sentEvidenceId: 'sent-evidence-001' });
    expect(store.applications.replace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'offer_sent', offerId: OFFER_ID,
    }), 4, SESSION);
  });
});
