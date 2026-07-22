import { describe, expect, it } from 'vitest';

import {
  applyRecruitmentOfferApprovalOutcome,
  createRecruitmentOffer,
  recordRecruitmentOfferDecision,
  recordRecruitmentOfferSent,
  recordRecruitmentOfferSigned,
  requestRecruitmentOfferSend,
  restoreRecruitmentOfferFromMigration,
  submitRecruitmentOffer,
  type RecruitmentOfferTerms,
} from './offer.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const TERMS: RecruitmentOfferTerms = {
  currency: 'CNY', monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
  annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
  proposedStartDate: '2026-08-15', probationMonths: 3,
  employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
};

function draft() {
  return createRecruitmentOffer({
    id: 'offer-001', tenantId: 'tenant-001', applicationId: 'application-001',
    candidateId: 'candidate-001', positionId: 'position-001',
    completedInterviewId: 'interview-001', terms: TERMS,
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
  }, NOW);
}

function approved() {
  const pending = submitRecruitmentOffer(draft(), {
    tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
    approvalInstanceId: 'approval-001',
  }, NOW);
  return applyRecruitmentOfferApprovalOutcome(pending, {
    tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
    outcome: 'approved', approvalVerified: true,
  }, NOW);
}

describe('RecruitmentOffer', () => {
  it('金额只接受安全整数分且当前币种严格限制为 CNY', () => {
    expect(() => createRecruitmentOffer({
      ...draft(), terms: { ...TERMS, monthlyBaseSalaryMinor: 1.5 },
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
    }, NOW)).toThrow('整数分');
    expect(() => createRecruitmentOffer({
      ...draft(), terms: { ...TERMS, currency: 'USD' as 'CNY' },
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
    }, NOW)).toThrow('CNY');
  });

  it('客户端自报审批通过失败关闭', () => {
    const pending = submitRecruitmentOffer(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      approvalInstanceId: 'approval-001',
    }, NOW);
    expect(() => applyRecruitmentOfferApprovalOutcome(pending, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
      outcome: 'approved', approvalVerified: false,
    }, NOW)).toThrow('可信审批证据');
  });

  it('发送意图不能直接变成已发送，必须匹配可信投递证据', () => {
    const sending = requestRecruitmentOfferSend(approved(), {
      tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
    }, NOW);
    expect(sending.status).toBe('sending');
    expect(() => recordRecruitmentOfferSent(sending, {
      tenantId: 'tenant-001', expectedVersion: 4, sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001', deliveryVerified: false,
    }, NOW)).toThrow('可信投递证据');
  });

  it('候选人接受和签署分别固化独立可信证据', () => {
    const sending = requestRecruitmentOfferSend(approved(), {
      tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
    }, NOW);
    const sent = recordRecruitmentOfferSent(sending, {
      tenantId: 'tenant-001', expectedVersion: 4, sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001', deliveryVerified: true,
    }, NOW);
    const accepted = recordRecruitmentOfferDecision(sent, {
      tenantId: 'tenant-001', expectedVersion: 5, decision: 'accepted',
      acceptanceEvidenceId: 'accept-evidence-001', candidateEvidenceVerified: true,
    }, NOW);
    const signed = recordRecruitmentOfferSigned(accepted, {
      tenantId: 'tenant-001', expectedVersion: 6, esignFlowId: 'esign-flow-001',
      signedEvidenceId: 'signed-evidence-001', esignEvidenceVerified: true,
    }, NOW);
    expect(signed).toMatchObject({
      status: 'signed', sentEvidenceId: 'sent-evidence-001',
      acceptanceEvidenceId: 'accept-evidence-001', esignFlowId: 'esign-flow-001',
      signedEvidenceId: 'signed-evidence-001', version: 7,
    });
  });

  it('迁移 Offer 使用终结审批历史并验证 L4 快照版本', () => {
    const restored = restoreRecruitmentOfferFromMigration({
      id: 'offer-002', tenantId: 'tenant-001', applicationId: 'application-001',
      candidateId: 'candidate-001', positionId: 'position-001',
      completedInterviewId: 'interview-001', terms: TERMS,
      expiresAt: '2026-08-01T00:00:00.000Z',
      retentionExpiresAt: '2033-08-01T00:00:00.000Z', status: 'approved',
      approvalInstanceId: null, approvalHistoryId: 'approval-history-001',
      sendRequestId: null, sentEvidenceId: null, acceptanceEvidenceId: null,
      esignFlowId: null, signedEvidenceId: null, version: 3, createdBy: 'actor-001',
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'));
    expect(restored).toMatchObject({
      status: 'approved', approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001', version: 3,
    });
    expect(() => restoreRecruitmentOfferFromMigration({
      ...restored, version: 4,
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrow(/版本/u);
  });
});
