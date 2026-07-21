import { describe, expect, it } from 'vitest';

import { createCandidateApplication, transitionCandidateApplication } from './application.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');

function application() {
  return createCandidateApplication({
    id: 'application-001',
    tenantId: 'tenant-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    sourceChannel: 'portal',
  }, NOW);
}

function advance(
  current: ReturnType<typeof application>,
  targetStage: Parameters<typeof transitionCandidateApplication>[1]['targetStage'],
  evidenceId?: string,
) {
  return transitionCandidateApplication(current, {
    tenantId: 'tenant-001',
    expectedVersion: current.version,
    actorId: 'actor-001',
    targetStage,
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }, new Date(NOW.getTime() + current.version * 1_000)).application;
}

describe('CandidateApplication', () => {
  it('候选人与职位申请分离，同一候选人可创建多个独立申请', () => {
    const first = application();
    const second = createCandidateApplication({
      id: 'application-002', tenantId: 'tenant-001', candidateId: first.candidateId,
      positionId: 'position-002', sourceChannel: 'referral',
    }, NOW);
    expect(first.candidateId).toBe(second.candidateId);
    expect(first.positionId).not.toBe(second.positionId);
  });

  it('完整主链逐步推进并固化每类受信任证据', () => {
    const screening = advance(application(), 'screening');
    const interview = advance(screening, 'interview');
    const offerApproval = advance(interview, 'offer_approval', 'interview-001');
    const offerSent = advance(offerApproval, 'offer_sent', 'offer-001');
    const accepted = advance(offerSent, 'offer_accepted', 'acceptance-001');
    const preboarding = advance(accepted, 'preboarding', 'onboarding-001');
    const hired = advance(preboarding, 'hired', 'employment-001');
    expect(hired).toMatchObject({
      stage: 'hired',
      completedInterviewId: 'interview-001',
      offerId: 'offer-001',
      acceptanceEvidenceId: 'acceptance-001',
      onboardingInstanceId: 'onboarding-001',
      employmentId: 'employment-001',
      version: 8,
    });
    expect(hired.endedAt).not.toBeNull();
  });

  it('禁止跳阶段、回退以及缺少跨聚合证据', () => {
    expect(() => advance(application(), 'interview')).toThrow('阶段迁移无效');
    const screening = advance(application(), 'screening');
    const interview = advance(screening, 'interview');
    expect(() => advance(interview, 'offer_approval')).toThrow('缺少受信任证据');
    expect(() => advance(screening, 'applied' as never)).toThrow('阶段迁移无效');
  });

  it('淘汰和退出必须使用原因码，终态不可复活', () => {
    expect(() => transitionCandidateApplication(application(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      targetStage: 'rejected',
    }, NOW)).toThrow('必须提供原因码');
    const rejected = transitionCandidateApplication(application(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      targetStage: 'rejected', reasonCode: 'qualification_mismatch',
    }, NOW).application;
    expect(() => transitionCandidateApplication(rejected, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'actor-001',
      targetStage: 'screening',
    }, NOW)).toThrow('阶段迁移无效');
  });

  it('阶段事件不包含姓名、手机、邮箱、简历或 Offer 条款', () => {
    const result = transitionCandidateApplication(application(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      targetStage: 'screening',
    }, NOW);
    expect(result.event).toMatchObject({ from: 'applied', to: 'screening', resultingVersion: 2 });
    expect(JSON.stringify(result.event)).not.toMatch(/name|phone|email|resume|salary/iu);
  });
});
