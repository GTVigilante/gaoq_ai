import { describe, expect, it } from 'vitest';

import {
  createCandidateApplication,
  restoreCandidateApplicationBaselineFromMigration,
  restoreCandidateApplicationOfferStagesFromMigration,
  transitionCandidateApplication,
} from './application.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');

function application() {
  return createCandidateApplication({
    id: 'application-001',
    tenantId: 'tenant-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    consentEvidenceId: 'consent-evidence-001',
    sourceChannel: 'portal',
  }, NOW);
}

function advance(
  current: ReturnType<typeof application>,
  targetStage: Parameters<typeof transitionCandidateApplication>[1]['targetStage'],
  evidenceId?: string,
  employmentId?: string,
) {
  return transitionCandidateApplication(current, {
    tenantId: 'tenant-001',
    expectedVersion: current.version,
    actorId: 'actor-001',
    targetStage,
    ...(evidenceId === undefined ? {} : { evidenceId }),
    ...(employmentId === undefined ? {} : { employmentId }),
  }, new Date(NOW.getTime() + current.version * 1_000)).application;
}

describe('CandidateApplication', () => {
  it('候选人与职位申请分离，同一候选人可创建多个独立申请', () => {
    const first = application();
    const second = createCandidateApplication({
      id: 'application-002', tenantId: 'tenant-001', candidateId: first.candidateId,
      positionId: 'position-002', consentEvidenceId: 'consent-evidence-002',
      sourceChannel: 'referral',
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
    const hiredTransition = transitionCandidateApplication(preboarding, {
      tenantId: 'tenant-001',
      expectedVersion: preboarding.version,
      actorId: 'actor-001',
      targetStage: 'hired',
      evidenceId: 'completion-evidence-001',
      employmentId: 'employment-001',
    }, new Date(NOW.getTime() + preboarding.version * 1_000));
    const hired = hiredTransition.application;
    expect(hired).toMatchObject({
      stage: 'hired',
      completedInterviewId: 'interview-001',
      offerId: 'offer-001',
      acceptanceEvidenceId: 'acceptance-001',
      onboardingInstanceId: 'onboarding-001',
      employmentId: 'employment-001',
      version: 8,
    });
    expect(hiredTransition.event).toMatchObject({
      evidenceId: 'completion-evidence-001',
      to: 'hired',
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

  it('入职完成证据与劳动关系引用必须分离，且只允许 hired 绑定劳动关系', () => {
    const screening = advance(application(), 'screening');
    const interview = advance(screening, 'interview');
    const offerApproval = advance(interview, 'offer_approval', 'interview-001');
    const offerSent = advance(offerApproval, 'offer_sent', 'offer-001');
    const accepted = advance(offerSent, 'offer_accepted', 'acceptance-001');
    const preboarding = advance(accepted, 'preboarding', 'onboarding-001');
    expect(() => advance(
      preboarding,
      'hired',
      'completion-evidence-001',
    )).toThrow('必须绑定劳动关系');
    expect(() => advance(
      accepted,
      'preboarding',
      'onboarding-001',
      'employment-001',
    )).toThrow('非入职阶段禁止绑定劳动关系');
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

  it('迁移基线复用状态机验证动作顺序但不生成持久化阶段日志', () => {
    const restored = restoreCandidateApplicationBaselineFromMigration({
      id: 'application-001', tenantId: 'tenant-001', candidateId: 'candidate-001',
      positionId: 'position-001', consentEvidenceId: 'consent-evidence-001',
      sourceChannel: 'legacy_ats', actorId: 'migration-agent-001',
      actions: [
        { targetStage: 'screening', reasonCode: null, occurredAt: '2026-07-20T01:00:00.000Z' },
        { targetStage: 'interview', reasonCode: null, occurredAt: '2026-07-20T02:00:00.000Z' },
      ],
      expectedStage: 'interview', expectedVersion: 3,
      appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
      updatedAt: '2026-07-20T02:00:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'));
    expect(restored).toMatchObject({ stage: 'interview', version: 3, endedAt: null });
    expect(() => restoreCandidateApplicationBaselineFromMigration({
      id: 'application-001', tenantId: 'tenant-001', candidateId: 'candidate-001',
      positionId: 'position-001', consentEvidenceId: 'consent-evidence-001',
      sourceChannel: 'legacy_ats', actorId: 'migration-agent-001',
      actions: [{
        targetStage: 'interview', reasonCode: null, occurredAt: '2026-07-20T01:00:00.000Z',
      }],
      expectedStage: 'interview', expectedVersion: 2,
      appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
      updatedAt: '2026-07-20T01:00:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrow('阶段迁移无效');
  });

  it('Offer 迁移从面试基线回放接受链并核对最终控制事实', () => {
    const screening = advance(application(), 'screening');
    const interview = advance(screening, 'interview');
    const restored = restoreCandidateApplicationOfferStagesFromMigration(interview, {
      actorId: 'migration-agent-001',
      actions: [
        {
          targetStage: 'offer_approval', evidenceId: 'interview-001', reasonCode: null,
          occurredAt: '2026-07-21T08:00:03.000Z',
        },
        {
          targetStage: 'offer_sent', evidenceId: 'offer-001', reasonCode: null,
          occurredAt: '2026-07-21T08:00:04.000Z',
        },
        {
          targetStage: 'offer_accepted', evidenceId: 'acceptance-evidence-001', reasonCode: null,
          occurredAt: '2026-07-21T08:00:05.000Z',
        },
      ],
      expectedStage: 'offer_accepted', expectedVersion: 6, endedAt: null,
      updatedAt: '2026-07-21T08:00:05.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'));
    expect(restored).toMatchObject({
      stage: 'offer_accepted', completedInterviewId: 'interview-001',
      offerId: 'offer-001', acceptanceEvidenceId: 'acceptance-evidence-001', version: 6,
    });
  });

  it('Offer 迁移拒绝伪造基线时间、乱序动作与不一致终态', () => {
    const screening = advance(application(), 'screening');
    const interview = advance(screening, 'interview');
    const baseInput = {
      actorId: 'migration-agent-001',
      actions: [{
        targetStage: 'offer_approval' as const, evidenceId: 'interview-001', reasonCode: null,
        occurredAt: '2026-07-21T08:00:03.000Z',
      }],
      expectedStage: 'offer_approval' as const, expectedVersion: 4, endedAt: null,
      updatedAt: '2026-07-21T08:00:03.000Z',
    };
    expect(() => restoreCandidateApplicationOfferStagesFromMigration({
      ...interview, updatedAt: '2026-07-21 08:00:02',
    }, baseInput, new Date('2026-07-22T00:00:00.000Z'))).toThrow('规范 UTC ISO');
    expect(() => restoreCandidateApplicationOfferStagesFromMigration(interview, {
      ...baseInput,
      actions: [{
        targetStage: 'offer_approval', evidenceId: 'interview-001', reasonCode: null,
        occurredAt: '2026-07-21T08:00:01.000Z',
      }],
      updatedAt: '2026-07-21T08:00:01.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrow('按时间排序');
    expect(() => restoreCandidateApplicationOfferStagesFromMigration(interview, {
      ...baseInput, expectedStage: 'rejected',
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrow('控制事实不一致');
  });
});
