import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  applyRecruitmentOfferApprovalOutcome,
  createRecruitmentOffer,
  recordRecruitmentOfferDecision,
  recordRecruitmentOfferSent,
  recordRecruitmentOfferSigned,
  requestRecruitmentOfferSend,
  submitRecruitmentOffer,
  type CandidateApplicationStage,
  type RecruitmentOfferStatus,
} from '../domain/index.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import { RecruitmentWriteConflictError } from '../persistence/recruitment.repositories.js';
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
  if (status === 'sent' || status === 'accepted' || status === 'declined' || status === 'signed') {
    const sending = requestRecruitmentOfferSend(approved, {
      tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
    }, NOW);
    const sent = recordRecruitmentOfferSent(sending, {
      tenantId: 'tenant-001', expectedVersion: 4, sendRequestId: 'send-request-001',
      sentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4X5', deliveryVerified: true,
    }, NOW);
    if (status === 'sent') return sent;
    const decided = recordRecruitmentOfferDecision(sent, {
      tenantId: 'tenant-001',
      expectedVersion: 5,
      decision: status === 'declined' ? 'declined' : 'accepted',
      acceptanceEvidenceId: 'accept-evidence-001',
      candidateEvidenceVerified: true,
    }, NOW);
    if (status !== 'signed') return decided;
    return recordRecruitmentOfferSigned(decided, {
      tenantId: 'tenant-001',
      expectedVersion: 6,
      esignFlowId: 'esign-flow-001',
      signedEvidenceId: 'signed-evidence-001',
      esignEvidenceVerified: true,
    }, NOW);
  }
  throw new Error(`测试暂不支持状态 ${status}`);
}

function fixture(options?: {
  readonly actorType?: 'user' | 'service' | 'system_job';
  readonly offerStatus?: RecruitmentOfferStatus;
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
  return {
    service,
    execute,
    context,
    approvals,
    profiles,
    applications,
    stages,
    positions,
    interviews,
    offers,
    evidence,
    outbox,
  };
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

  it.each([
    ['缺少毫秒与 UTC 规范后缀', '2027-08-01T00:00:00Z'],
    ['日期字符串不是时间戳', '2027-08-01'],
    ['无法解析的时间', 'invalid-date'],
  ])('创建 Offer 拒绝%s', async (_scenario, expiresAt) => {
    const store = fixture();
    await expect(store.service.create(APPLICATION_ID, 3, 'offer-create-key-002', {
      completedInterviewId: INTERVIEW_ID, terms, expiresAt,
      retentionExpiresAt: '2033-08-01T00:00:00.000Z',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_INVALID_DATE' },
    });
    expect(store.offers.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
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

  it('迁移写入要求服务身份、双 Scope 和精确 WORM 证据', async () => {
    const actor = fixture({
      actorType: 'user',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(actor.service.importOfferFromMigration('migration-auth-actor', migrationInput()))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' },
      });

    const scope = fixture({ actorType: 'service', scopes: ['erp:migration:execute'] });
    await expect(scope.service.importOfferFromMigration('migration-auth-scope', migrationInput()))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' },
      });

    const reference = fixture({
      actorType: 'system_job',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(reference.service.importOfferFromMigration('migration-evidence-ref', {
      ...migrationInput(),
      migrationEvidenceRef: 'https://example.invalid/evidence',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_INVALID' },
    });
    await expect(reference.service.importOfferFromMigration('migration-evidence-hash', {
      ...migrationInput(),
      evidenceChecksum: 'invalid',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_EVIDENCE_INVALID' },
    });
    expect(reference.execute).not.toHaveBeenCalled();
  });

  it('迁移 Offer 拒绝缺失申请、面试、职位、创建人和审批映射', async () => {
    const options = {
      actorType: 'service' as const,
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    };

    const noApplication = fixture(options);
    noApplication.applications.findById.mockResolvedValue(null);
    await expect(noApplication.service.importOfferFromMigration(
      'migration-no-application',
      migrationInput(),
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_FOUND' } });

    const interview = fixture(options);
    interview.interviews.findById.mockResolvedValue({
      id: INTERVIEW_ID,
      applicationId: 'different-application',
      status: 'completed',
    });
    await expect(interview.service.importOfferFromMigration(
      'migration-invalid-interview',
      migrationInput(),
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_INTERVIEW_INVALID' },
    });

    const position = fixture(options);
    position.positions.findById.mockResolvedValue(null);
    await expect(position.service.importOfferFromMigration(
      'migration-invalid-position',
      migrationInput(),
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_POSITION_INVALID' },
    });

    const creator = fixture(options);
    creator.profiles.findActorIdByEmployee.mockResolvedValue(null);
    await expect(creator.service.importOfferFromMigration(
      'migration-invalid-creator',
      migrationInput(),
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_CREATOR_INVALID' },
    });

    const approval = fixture(options);
    approval.approvals.verifyRecruitmentMigrationReference.mockResolvedValue({
      id: APPROVAL_ID,
      type: 'legacy_history',
      templateCode: 'different_template',
      outcome: 'approved',
    });
    await expect(approval.service.importOfferFromMigration(
      'migration-invalid-approval',
      migrationInput(),
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_APPROVAL_INVALID' },
    });
  });

  it('迁移 Offer 支持完整聚合、证据和申请终态的不可变重放', async () => {
    const options = {
      actorType: 'service' as const,
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    };
    const first = fixture(options);
    const input = migrationInput();
    await first.service.importOfferFromMigration('migration-replay-seed', input);
    const insertedOffer = first.offers.insertMigrated.mock.calls[0]?.[0] as unknown as
      ReturnType<typeof offer>;
    const migratedApplication = first.applications.replace.mock.calls[0]?.[0] as unknown as
      ReturnType<typeof application>;
    const migratedEvidence = first.evidence.append.mock.calls.map((call) =>
      call[0] as unknown as Readonly<Record<string, unknown>>,
    );

    const replay = fixture(options);
    replay.offers.findById.mockResolvedValue(insertedOffer);
    replay.evidence.findByOffer.mockResolvedValue(migratedEvidence);
    replay.applications.findById.mockResolvedValue(migratedApplication);
    replay.offers.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    const result = await replay.service.importOfferFromMigration(
      'migration-replay-existing',
      { ...input, targetId: insertedOffer.id },
    );
    expect(result.offer).toEqual(expect.objectContaining({
      id: insertedOffer.id,
      status: 'accepted',
      version: 6,
    }));
    expect(replay.offers.insertMigrated).not.toHaveBeenCalled();
    expect(replay.applications.replace).not.toHaveBeenCalled();
    expect(replay.outbox.append).not.toHaveBeenCalled();
  });

  it('迁移 Offer 拒绝既有聚合、证据、申请或 WORM 档案漂移', async () => {
    const options = {
      actorType: 'service' as const,
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    };
    const first = fixture(options);
    const input = migrationInput();
    await first.service.importOfferFromMigration('migration-immutable-seed', input);
    const insertedOffer = first.offers.insertMigrated.mock.calls[0]?.[0] as unknown as
      ReturnType<typeof offer>;
    const migratedApplication = first.applications.replace.mock.calls[0]?.[0] as unknown as
      ReturnType<typeof application>;
    const migratedEvidence = first.evidence.append.mock.calls.map((call) =>
      call[0] as unknown as Readonly<Record<string, unknown>>,
    );
    const replay = fixture(options);
    replay.offers.findById.mockResolvedValue(insertedOffer);
    replay.evidence.findByOffer.mockResolvedValue(migratedEvidence);
    replay.applications.findById.mockResolvedValue(migratedApplication);
    replay.offers.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: 'x'.repeat(43),
    });
    await expect(replay.service.importOfferFromMigration(
      'migration-immutable-drift',
      { ...input, targetId: insertedOffer.id },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_OFFER_IMMUTABLE' },
    });
  });

  it('迁移支持草稿和已签署终态并恢复签署证据', async () => {
    const options = {
      actorType: 'service' as const,
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    };
    const draft = fixture(options);
    const draftResult = await draft.service.importOfferFromMigration('migration-draft', {
      ...migrationInput(),
      status: 'draft',
      approvalReferenceType: null,
      approvalReferenceId: null,
      sendRequested: false,
      sentProof: null,
      decisionProof: null,
      version: 1,
      updatedAt: '2026-07-21T01:00:00.000Z',
      applicationActions: [],
      expectedApplicationStage: 'interview',
      expectedApplicationVersion: 3,
      applicationUpdatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(draftResult.offer).toMatchObject({ status: 'draft', version: 1 });
    expect(draft.approvals.verifyRecruitmentMigrationReference).not.toHaveBeenCalled();

    const signed = fixture(options);
    const signedResult = await signed.service.importOfferFromMigration('migration-signed', {
      ...migrationInput(),
      status: 'signed',
      signedProof: {
        proofHash: 'd'.repeat(43),
        occurredAt: '2026-07-21T05:00:00.000Z',
      },
      version: 7,
      updatedAt: '2026-07-21T05:00:00.000Z',
    });
    expect(signedResult.offer).toMatchObject({
      status: 'signed',
      version: 7,
    });
    expect(signed.evidence.append).toHaveBeenCalledTimes(3);
    expect(signed.evidence.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'signed',
        proofHash: 'd'.repeat(43),
        source: 'migration_worm',
      }),
      SESSION,
    );
  });

  it('创建 Offer 拒绝申请版本、阶段、面试、职位、部门和日期异常', async () => {
    const createInput = {
      completedInterviewId: INTERVIEW_ID,
      terms,
      expiresAt: '2027-08-01T00:00:00.000Z',
      retentionExpiresAt: '2033-08-01T00:00:00.000Z',
    };
    const version = fixture();
    await expect(version.service.create(APPLICATION_ID, 2, 'create-version', createInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const stage = fixture({ applicationStage: 'screening' });
    await expect(stage.service.create(APPLICATION_ID, 2, 'create-stage', createInput))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_OFFER_APPLICATION_STAGE_INVALID' },
      });

    const interview = fixture();
    interview.interviews.findById.mockResolvedValue(null);
    await expect(interview.service.create(APPLICATION_ID, 3, 'create-interview', createInput))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_OFFER_INTERVIEW_EVIDENCE_INVALID' },
      });

    const position = fixture();
    position.positions.findById.mockResolvedValue(null);
    await expect(position.service.create(APPLICATION_ID, 3, 'create-position', createInput))
      .rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');

    const department = fixture();
    department.context.getActorRequired.mockReturnValue({
      ...department.context.getActorRequired(),
      departmentIds: [],
      scopes: [],
    });
    await expect(department.service.create(APPLICATION_ID, 3, 'create-department', createInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_OFFER_WRITE_DENIED' } });

    const date = fixture();
    await expect(date.service.create(APPLICATION_ID, 3, 'create-date', {
      ...createInput,
      expiresAt: 'invalid',
    })).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INVALID_DATE' } });
  });

  it('提交 Offer 支持恢复既有审批并拒绝无效提交状态', async () => {
    const resumed = fixture({ offerStatus: 'pending_approval', applicationStage: 'offer_approval' });
    const resumedResult = await resumed.service.submit(OFFER_ID, 2, 'submit-resume');
    expect(resumedResult.offer).toMatchObject({
      status: 'pending_approval',
      approvalInstanceId: APPROVAL_ID,
      version: 2,
    });
    expect(resumed.approvals.createInstance).not.toHaveBeenCalled();

    const invalid = fixture();
    invalid.approvals.submitInstance.mockResolvedValue({
      instance: { id: APPROVAL_ID, status: 'draft', version: 2 },
    });
    await expect(invalid.service.submit(OFFER_ID, 1, 'submit-invalid'))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_OFFER_APPROVAL_SUBMIT_INVALID' },
      });
  });

  it('同步审批验证状态、模板并处理批准和拒绝终态', async () => {
    const invalidState = fixture({ offerStatus: 'draft' });
    await expect(invalidState.service.syncApproval(OFFER_ID, 1, 'sync-invalid-state'))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_OFFER_APPROVAL_SYNC_INVALID' },
      });

    const template = fixture({ offerStatus: 'pending_approval' });
    template.approvals.getInstanceStatusForRecruitmentOffer.mockResolvedValue({
      id: APPROVAL_ID,
      status: 'approved',
      templateCode: 'different_template',
      templateRevision: 1,
      riskLevel: 'R2',
      version: 3,
      submittedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    });
    await expect(template.service.syncApproval(OFFER_ID, 2, 'sync-template'))
      .rejects.toMatchObject({
        response: { code: 'RECRUITMENT_OFFER_APPROVAL_TEMPLATE_MISMATCH' },
      });

    const approved = fixture({
      offerStatus: 'pending_approval',
      approvalStatus: 'approved',
      applicationStage: 'offer_approval',
    });
    const approvedResult = await approved.service.syncApproval(OFFER_ID, 2, 'sync-approved');
    expect(approvedResult.offer).toMatchObject({ status: 'approved', version: 3 });
    expect(approved.applications.replace).not.toHaveBeenCalled();

    const rejected = fixture({
      offerStatus: 'pending_approval',
      approvalStatus: 'rejected',
      applicationStage: 'offer_approval',
    });
    const rejectedResult = await rejected.service.syncApproval(OFFER_ID, 2, 'sync-rejected');
    expect(rejectedResult.offer).toMatchObject({ status: 'rejected', version: 3 });
    const rejectedApplication = rejected.applications.replace.mock.calls[0]?.[0] as unknown as {
      readonly stage: string;
      readonly endedAt: string | null;
    };
    expect(rejectedApplication.stage).toBe('rejected');
    expect(rejectedApplication.endedAt).toEqual(expect.any(String));
    expect(rejected.applications.replace).toHaveBeenCalledWith(
      rejectedApplication,
      4,
      SESSION,
    );
  });

  it('已终结审批同步要求保留审批引用并保持幂等结果', async () => {
    const approved = fixture({ offerStatus: 'approved' });
    const result = await approved.service.syncApproval(OFFER_ID, 3, 'sync-approved-replay');
    expect(result.offer).toMatchObject({ status: 'approved', version: 3 });

    const invalid = fixture({ offerStatus: 'approved' });
    invalid.offers.findById.mockResolvedValue({
      ...offer('approved'),
      approvalInstanceId: null,
    });
    await expect(invalid.service.syncApproval(OFFER_ID, 3, 'sync-approved-invalid'))
      .rejects.toThrow('RECRUITMENT_OFFER_APPROVAL_INVALID');
  });

  it('候选人拒绝 Offer 时同步推进申请 withdrawn 并记录原因', async () => {
    const store = fixture({
      offerStatus: 'sent',
      applicationStage: 'offer_sent',
      scopes: ['erp:recruitment:offer:candidate_decide'],
    });
    const result = await store.service.recordCandidateDecision(
      OFFER_ID,
      5,
      'decision-declined',
      {
        decision: 'declined',
        candidateId: CANDIDATE_ID,
        authenticationEvidenceId: 'auth-evidence-declined',
        proofHash: 'e'.repeat(43),
        decidedAt: '2026-07-21T00:02:00.000Z',
      },
    );
    expect(result.offer).toMatchObject({ status: 'declined', version: 6 });
    const withdrawnApplication = store.applications.replace.mock.calls[0]?.[0] as unknown as {
      readonly stage: string;
      readonly endedAt: string | null;
    };
    expect(withdrawnApplication.stage).toBe('withdrawn');
    expect(withdrawnApplication.endedAt).toEqual(expect.any(String));
    expect(store.applications.replace).toHaveBeenCalledWith(
      withdrawnApplication,
      5,
      SESSION,
    );
    expect(store.stages.append).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'offer_declined' }),
      SESSION,
    );
  });

  it('投递和候选决定拒绝倒置的外部证据时间', async () => {
    const sent = fixture({
      offerStatus: 'sending',
      applicationStage: 'offer_approval',
      scopes: ['erp:integration:offer:deliver'],
    });
    await expect(sent.service.recordSentForIntegration(
      OFFER_ID,
      4,
      'sent-time-invalid',
      {
        sendRequestId: 'send-request-001',
        proofHash: 'a'.repeat(43),
        deliveredAt: '2026-07-20T23:59:59.000Z',
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_EVIDENCE_TIME_INVALID' },
    });

    const decision = fixture({
      offerStatus: 'sent',
      applicationStage: 'offer_sent',
      scopes: ['erp:recruitment:offer:candidate_decide'],
    });
    await expect(decision.service.recordCandidateDecision(
      OFFER_ID,
      5,
      'decision-time-invalid',
      {
        decision: 'accepted',
        candidateId: CANDIDATE_ID,
        authenticationEvidenceId: 'auth-evidence-001',
        proofHash: 'b'.repeat(43),
        decidedAt: '2026-07-20T23:59:59.000Z',
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_EVIDENCE_TIME_INVALID' },
    });
  });

  it('eSign 完成只允许受信任 Scope 并生成脱敏签署事件', async () => {
    const denied = fixture({ offerStatus: 'accepted', scopes: [] });
    await expect(denied.service.recordSignedForIntegration(
      OFFER_ID,
      6,
      'signed-denied',
      { esignFlowId: 'esign-flow-001', signedEvidenceId: 'signed-evidence-001' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_TRUSTED_WORKFLOW_REQUIRED' },
    });

    const store = fixture({
      offerStatus: 'accepted',
      scopes: ['erp:integration:esign:apply'],
    });
    const result = await store.service.recordSignedForIntegration(
      OFFER_ID,
      6,
      'signed-success',
      { esignFlowId: 'esign-flow-001', signedEvidenceId: 'signed-evidence-001' },
    );
    expect(result.offer).toMatchObject({
      status: 'signed',
      version: 7,
      esignFlowId: 'esign-flow-001',
      signedEvidenceId: 'signed-evidence-001',
    });
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recruitment.offer.signed' }),
      SESSION,
    );
  });

  it('读取 Offer 支持部门权限或 read_all 并拒绝越权', async () => {
    const department = fixture({ offerStatus: 'approved' });
    const result = await department.service.get(OFFER_ID);
    expect(result).toMatchObject({ id: OFFER_ID, status: 'approved' });
    expect(result).not.toHaveProperty('terms');

    const all = fixture({ offerStatus: 'approved', scopes: ['erp:recruitment:offer:read_all'] });
    all.context.getActorRequired.mockReturnValue({
      ...all.context.getActorRequired(),
      departmentIds: [],
    });
    await expect(all.service.get(OFFER_ID)).resolves.toMatchObject({ id: OFFER_ID });

    const denied = fixture({ offerStatus: 'approved', scopes: [] });
    denied.context.getActorRequired.mockReturnValue({
      ...denied.context.getActorRequired(),
      departmentIds: [],
    });
    await expect(denied.service.get(OFFER_ID)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_READ_DENIED' },
    });
  });

  it('统一映射未找到、写冲突、重复键和领域错误', async () => {
    const missingOffer = fixture();
    missingOffer.offers.findById.mockResolvedValue(null);
    await expect(missingOffer.service.get(OFFER_ID)).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_NOT_FOUND' },
    });

    const writeConflict = fixture({ offerStatus: 'approved' });
    writeConflict.offers.replace.mockRejectedValue(new RecruitmentWriteConflictError());
    await expect(writeConflict.service.requestSend(OFFER_ID, 3, 'write-conflict'))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const duplicate = fixture();
    duplicate.offers.insert.mockRejectedValue({ code: 11_000 });
    await expect(duplicate.service.create(
      APPLICATION_ID,
      3,
      'duplicate-offer',
      {
        completedInterviewId: INTERVIEW_ID,
        terms,
        expiresAt: '2027-08-01T00:00:00.000Z',
        retentionExpiresAt: '2033-08-01T00:00:00.000Z',
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_ALREADY_EXISTS' },
    });

    const badRequest = fixture();
    await expect(badRequest.service.create(
      APPLICATION_ID,
      3,
      'invalid-terms',
      {
        completedInterviewId: INTERVIEW_ID,
        terms: { ...terms, monthlyBaseSalaryMinor: 0 },
        expiresAt: '2027-08-01T00:00:00.000Z',
        retentionExpiresAt: '2033-08-01T00:00:00.000Z',
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_OFFER_AMOUNT_INVALID' },
    });
  });
});
