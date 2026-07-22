import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  applyRecruitmentOfferApprovalOutcome,
  createRecruitmentOffer,
  recordRecruitmentOfferSent,
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
  RecruitmentOfferEvidenceRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import {
  RecruitmentOfferService,
  type ImportRecruitmentOfferFromMigrationInput,
} from './recruitment-offer.service.js';

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

function migrationInput(): ImportRecruitmentOfferFromMigrationInput {
  return {
    targetId: null, applicationId: APPLICATION_ID, completedInterviewId: INTERVIEW_ID,
    createdByEmployeeId: 'employee-hr', terms,
    expiresAt: '2027-08-01T00:00:00.000Z',
    retentionExpiresAt: '2033-08-01T00:00:00.000Z', status: 'accepted',
    approvalReferenceType: 'legacy_history', approvalReferenceId: APPROVAL_ID,
    sendRequested: true,
    sentProof: { proofHash: 'a'.repeat(43), occurredAt: '2026-07-21T03:00:00.000Z' },
    decisionProof: {
      decision: 'accepted', proofHash: 'b'.repeat(43),
      occurredAt: '2026-07-21T04:00:00.000Z',
    },
    signedProof: null, version: 6,
    createdAt: '2026-07-21T01:00:00.000Z', updatedAt: '2026-07-21T04:00:00.000Z',
    applicationBaselineVersion: 3,
    applicationBaselineUpdatedAt: '2026-07-21T00:00:00.000Z',
    applicationActions: [
      { targetStage: 'offer_approval', reasonCode: null, occurredAt: '2026-07-21T02:00:00.000Z' },
      { targetStage: 'offer_sent', reasonCode: null, occurredAt: '2026-07-21T03:00:00.000Z' },
      { targetStage: 'offer_accepted', reasonCode: null, occurredAt: '2026-07-21T04:00:00.000Z' },
    ],
    expectedApplicationStage: 'offer_accepted', expectedApplicationVersion: 6,
    applicationEndedAt: null, applicationUpdatedAt: '2026-07-21T04:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/offer-001',
    evidenceChecksum: 'c'.repeat(43),
  };
}

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
  if (status === 'sent') {
    const sending = requestRecruitmentOfferSend(approved, {
      tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
    }, NOW);
    return recordRecruitmentOfferSent(sending, {
      tenantId: 'tenant-001', expectedVersion: 4, sendRequestId: 'send-request-001',
      sentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4X5', deliveryVerified: true,
    }, NOW);
  }
  throw new Error(`测试暂不支持状态 ${status}`);
}

function fixture(options?: {
  readonly actorType?: 'user' | 'service' | 'system_job';
  readonly offerStatus?:
    | 'draft'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'sending'
    | 'sent';
  readonly applicationStage?: CandidateApplicationStage;
  readonly approvalStatus?: 'running' | 'approved' | 'rejected';
  readonly migrationApprovalOutcome?: 'running' | 'approved' | 'rejected';
  readonly migrationApprovalType?: 'approval_instance' | 'legacy_history';
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
      actorId: 'actor-001', tenantId: 'tenant-001',
      actorType: options?.actorType ?? 'user' as const,
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
    verifyRecruitmentMigrationReference: vi.fn().mockResolvedValue({
      id: APPROVAL_ID, type: options?.migrationApprovalType ?? 'legacy_history',
      templateCode: 'recruitment_offer', outcome: options?.migrationApprovalOutcome ?? 'approved',
    }),
  };
  const applications = {
    findById: vi.fn().mockResolvedValue(application(options?.applicationStage)),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const profiles = { findActorIdByEmployee: vi.fn().mockResolvedValue('creator-actor-001') };
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
    insertMigrated: vi.fn().mockResolvedValue(undefined),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const evidence = {
    append: vi.fn().mockResolvedValue(undefined),
    findByOffer: vi.fn().mockResolvedValue([]),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentOfferService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    approvals as unknown as ApprovalApplicationService,
    profiles as unknown as AccessProfileRepository,
    applications as unknown as CandidateApplicationRepository,
    stages as unknown as CandidateApplicationStageRepository,
    positions as unknown as RecruitmentPositionRepository,
    interviews as unknown as RecruitmentInterviewRepository,
    offers as unknown as RecruitmentOfferRepository,
    evidence as unknown as RecruitmentOfferEvidenceRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return { service, execute, approvals, profiles, applications, stages, offers, evidence, outbox };
}

describe('RecruitmentOfferService', () => {
  it('迁移 Offer 原子写入 L4 聚合、外部摘要和申请最终阶段', async () => {
    const store = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const result = await store.service.importOfferFromMigration(
      'offer-migration-key-001', migrationInput(),
    );
    expect(store.approvals.verifyRecruitmentMigrationReference).toHaveBeenCalledWith(
      'legacy_history', APPROVAL_ID, SESSION,
    );
    expect(store.offers.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'accepted', approvalHistoryId: APPROVAL_ID, version: 6,
        createdBy: 'creator-actor-001',
      }),
      expect.stringContaining('/attachments/offer-001'), 'c'.repeat(43), SESSION,
    );
    expect(store.evidence.append).toHaveBeenCalledTimes(2);
    expect(store.evidence.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'actor-001', source: 'migration_worm' }), SESSION,
    );
    expect(store.applications.replace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'offer_accepted', completedInterviewId: INTERVIEW_ID,
      version: 6,
    }), 3, SESSION);
    expect(store.stages.append).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('标准福利计划');
    expect(result.offer).toMatchObject({ status: 'accepted', version: 6 });
    expect(result.offer).not.toHaveProperty('terms');
  });

  it('迁移 Offer 拒绝跨聚合终态矛盾和被篡改的申请基线时间', async () => {
    const mismatched = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(mismatched.service.importOfferFromMigration('offer-migration-key-002', {
      ...migrationInput(), expectedApplicationStage: 'rejected',
      applicationActions: [
        ...migrationInput().applicationActions.slice(0, 1),
        {
          targetStage: 'rejected', reasonCode: 'offer_approval_rejected',
          occurredAt: '2026-07-21T04:00:00.000Z',
        },
      ],
      expectedApplicationVersion: 5,
      applicationEndedAt: '2026-07-21T04:00:00.000Z',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_APPLICATION_CONTROL_INVALID' },
    });
    expect(mismatched.offers.insertMigrated).not.toHaveBeenCalled();

    const changedBaseline = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(changedBaseline.service.importOfferFromMigration('offer-migration-key-003', {
      ...migrationInput(), applicationBaselineUpdatedAt: '2026-07-20T23:59:59.000Z',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_APPLICATION_BASELINE_CONFLICT' },
    });
    expect(changedBaseline.offers.insertMigrated).not.toHaveBeenCalled();
  });

  it('迁移 Offer 拒绝语义相反的候选人决定和倒置证据时间线', async () => {
    const store = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(store.service.importOfferFromMigration('offer-migration-key-004', {
      ...migrationInput(),
      decisionProof: {
        decision: 'declined', proofHash: 'b'.repeat(43),
        occurredAt: '2026-07-21T04:00:00.000Z',
      },
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_APPLICATION_CONTROL_INVALID' },
    });
    await expect(store.service.importOfferFromMigration('offer-migration-key-005', {
      ...migrationInput(),
      sentProof: { proofHash: 'a'.repeat(43), occurredAt: '2026-07-21T03:30:00.000Z' },
      decisionProof: {
        decision: 'accepted', proofHash: 'b'.repeat(43),
        occurredAt: '2026-07-21T03:00:00.000Z',
      },
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_TIMELINE_CONTROL_INVALID' },
    });
    expect(store.offers.insertMigrated).not.toHaveBeenCalled();
  });

  it('迁移待审批与审批拒绝状态使用不同审批引用并精确回放申请', async () => {
    const pending = fixture({
      actorType: 'service', migrationApprovalType: 'approval_instance',
      migrationApprovalOutcome: 'running',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await pending.service.importOfferFromMigration('offer-migration-key-006', {
      ...migrationInput(), status: 'pending_approval',
      approvalReferenceType: 'approval_instance', sendRequested: false,
      sentProof: null, decisionProof: null, version: 2,
      updatedAt: '2026-07-21T02:00:00.000Z',
      applicationActions: [{
        targetStage: 'offer_approval', reasonCode: null,
        occurredAt: '2026-07-21T02:00:00.000Z',
      }],
      expectedApplicationStage: 'offer_approval', expectedApplicationVersion: 4,
      applicationUpdatedAt: '2026-07-21T02:00:00.000Z',
    });
    expect(pending.approvals.verifyRecruitmentMigrationReference).toHaveBeenCalledWith(
      'approval_instance', APPROVAL_ID, SESSION,
    );
    expect(pending.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'offer_approval', version: 4 }), 3, SESSION,
    );

    const rejected = fixture({
      actorType: 'service', migrationApprovalOutcome: 'rejected',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await rejected.service.importOfferFromMigration('offer-migration-key-007', {
      ...migrationInput(), status: 'rejected', sendRequested: false,
      sentProof: null, decisionProof: null, version: 3,
      updatedAt: '2026-07-21T02:30:00.000Z',
      applicationActions: [
        {
          targetStage: 'offer_approval', reasonCode: null,
          occurredAt: '2026-07-21T02:00:00.000Z',
        },
        {
          targetStage: 'rejected', reasonCode: 'offer_approval_rejected',
          occurredAt: '2026-07-21T02:30:00.000Z',
        },
      ],
      expectedApplicationStage: 'rejected', expectedApplicationVersion: 5,
      applicationEndedAt: '2026-07-21T02:30:00.000Z',
      applicationUpdatedAt: '2026-07-21T02:30:00.000Z',
    });
    expect(rejected.offers.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', approvalHistoryId: APPROVAL_ID, version: 3 }),
      expect.any(String), 'c'.repeat(43), SESSION,
    );
    expect(rejected.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'rejected', version: 5 }), 3, SESSION,
    );
  });

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
        sendRequestId: 'send-request-001', proofHash: 'a'.repeat(43),
        deliveredAt: '2026-07-21T00:01:00.000Z',
      },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_TRUSTED_WORKFLOW_REQUIRED' } });
    const store = fixture({
      offerStatus: 'sending', applicationStage: 'offer_approval',
      scopes: ['erp:integration:offer:deliver'],
    });
    const result = await store.service.recordSentForIntegration(
      OFFER_ID, 4, 'offer-delivery-key-002', {
        sendRequestId: 'send-request-001', proofHash: 'a'.repeat(43),
        deliveredAt: '2026-07-21T00:01:00.000Z',
      },
    );
    expect(result.offer).toMatchObject({ status: 'sent' });
    expect(result.offer.sentEvidenceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.evidence.append).toHaveBeenCalledWith(expect.objectContaining({
      id: result.offer.sentEvidenceId, kind: 'sent', source: 'integration_delivery',
      proofHash: 'a'.repeat(43),
    }), SESSION);
    expect(store.applications.replace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'offer_sent', offerId: OFFER_ID,
    }), 4, SESSION);
  });

  it('候选人决定必须绑定 Offer 候选人和门户认证证据', async () => {
    const mismatched = fixture({
      offerStatus: 'sending', applicationStage: 'offer_sent',
      scopes: ['erp:recruitment:offer:candidate_decide'],
    });
    await expect(mismatched.service.recordCandidateDecision(
      OFFER_ID, 4, 'offer-decision-key-001', {
        decision: 'accepted', candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Z9',
        authenticationEvidenceId: 'auth-evidence-001', proofHash: 'b'.repeat(43),
        decidedAt: '2026-07-21T00:02:00.000Z',
      },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_CANDIDATE_MISMATCH' } });
    expect(mismatched.evidence.append).not.toHaveBeenCalled();

    const store = fixture({
      offerStatus: 'sent', applicationStage: 'offer_sent',
      scopes: ['erp:recruitment:offer:candidate_decide'],
    });
    const result = await store.service.recordCandidateDecision(
      OFFER_ID, 5, 'offer-decision-key-002', {
        decision: 'accepted', candidateId: CANDIDATE_ID,
        authenticationEvidenceId: 'auth-evidence-001', proofHash: 'b'.repeat(43),
        decidedAt: '2026-07-21T00:02:00.000Z',
      },
    );
    expect(result.offer).toMatchObject({ status: 'accepted', version: 6 });
    expect(result.offer.acceptanceEvidenceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.evidence.append).toHaveBeenCalledWith(expect.objectContaining({
      id: result.offer.acceptanceEvidenceId, kind: 'accepted', source: 'candidate_portal',
      subjectCandidateId: CANDIDATE_ID, authenticationEvidenceId: 'auth-evidence-001',
    }), SESSION);
    expect(store.applications.replace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'offer_accepted', acceptanceEvidenceId: result.offer.acceptanceEvidenceId,
    }), 5, SESSION);
  });
});
