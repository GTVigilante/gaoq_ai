import { describe, expect, it } from 'vitest';

import { createRecruitmentOfferEvidence } from './offer-evidence.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const HASH = 'a'.repeat(43);

describe('RecruitmentOfferEvidence', () => {
  it('投递证据只保留发送请求与 SHA-256，不接受候选人身份字段', () => {
    const evidence = createRecruitmentOfferEvidence({
      id: 'evidence-001', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'sent',
      sendRequestId: 'send-request-001', proofHash: HASH, occurredAt: NOW,
      actorId: 'integration-worker-001',
    }, NOW);
    expect(evidence).toMatchObject({
      source: 'integration_delivery', sendRequestId: 'send-request-001',
      subjectCandidateId: null, authenticationEvidenceId: null,
    });
    expect(() => createRecruitmentOfferEvidence({
      id: 'evidence-001', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'sent',
      sendRequestId: 'send-request-001', subjectCandidateId: 'candidate-001',
      proofHash: HASH, occurredAt: NOW, actorId: 'integration-worker-001',
    }, NOW)).toThrow('类型与来源字段不一致');
  });

  it('候选人决定必须同时引用候选人和认证证据', () => {
    expect(() => createRecruitmentOfferEvidence({
      id: 'evidence-002', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'accepted',
      subjectCandidateId: 'candidate-001', proofHash: HASH,
      occurredAt: NOW, actorId: 'candidate-portal-001',
    }, NOW)).toThrow('类型与来源字段不一致');
    expect(createRecruitmentOfferEvidence({
      id: 'evidence-002', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'accepted',
      subjectCandidateId: 'candidate-001', authenticationEvidenceId: 'auth-evidence-001',
      proofHash: HASH, occurredAt: NOW, actorId: 'candidate-portal-001',
    }, NOW)).toMatchObject({ source: 'candidate_portal', kind: 'accepted' });
  });

  it('拒绝非 SHA-256 摘要和超出时钟偏差的未来事实', () => {
    expect(() => createRecruitmentOfferEvidence({
      id: 'evidence-001', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'sent',
      sendRequestId: 'send-request-001', proofHash: 'not-a-hash', occurredAt: NOW,
      actorId: 'integration-worker-001',
    }, NOW)).toThrow('SHA-256');
    expect(() => createRecruitmentOfferEvidence({
      id: 'evidence-001', tenantId: 'tenant-001', offerId: 'offer-001', kind: 'sent',
      sendRequestId: 'send-request-001', proofHash: HASH,
      occurredAt: new Date('2026-07-21T00:06:00.000Z'), actorId: 'integration-worker-001',
    }, NOW)).toThrow('时钟偏差');
  });
});
