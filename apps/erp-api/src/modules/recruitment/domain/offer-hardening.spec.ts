import { describe, expect, it } from 'vitest';

import {
  applyRecruitmentOfferApprovalOutcome,
  createRecruitmentOffer,
  expireRecruitmentOffer,
  recordRecruitmentOfferDecision,
  recordRecruitmentOfferSent,
  recordRecruitmentOfferSigned,
  requestRecruitmentOfferSend,
  restoreRecruitmentOfferFromMigration,
  submitRecruitmentOffer,
  validateRecruitmentOfferTerms,
  type RecruitmentOffer,
  type RecruitmentOfferTerms,
} from './offer.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const TERMS: RecruitmentOfferTerms = {
  currency: 'CNY',
  monthlyBaseSalaryMinor: 3_000_000,
  salaryMonths: 13,
  annualVariableTargetMinor: 6_000_000,
  signingBonusMinor: 1_000_000,
  proposedStartDate: '2026-08-15',
  probationMonths: 3,
  employmentType: 'full_time',
  workLocation: ' 上海 ',
  benefitsSummary: ' 标准福利计划 ',
};

function draft(): RecruitmentOffer {
  return createRecruitmentOffer({
    id: 'offer-001',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    terms: TERMS,
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'),
    actorId: 'actor-001',
  }, NOW);
}

function pending(): RecruitmentOffer {
  return submitRecruitmentOffer(draft(), {
    tenantId: 'tenant-001',
    expectedVersion: 1,
    actorId: 'actor-001',
    approvalInstanceId: 'approval-001',
  }, NOW);
}

function approved(): RecruitmentOffer {
  return applyRecruitmentOfferApprovalOutcome(pending(), {
    tenantId: 'tenant-001',
    expectedVersion: 2,
    approvalInstanceId: 'approval-001',
    outcome: 'approved',
    approvalVerified: true,
  }, NOW);
}

function sending(): RecruitmentOffer {
  return requestRecruitmentOfferSend(approved(), {
    tenantId: 'tenant-001',
    expectedVersion: 3,
    sendRequestId: 'send-request-001',
  }, NOW);
}

function sent(): RecruitmentOffer {
  return recordRecruitmentOfferSent(sending(), {
    tenantId: 'tenant-001',
    expectedVersion: 4,
    sendRequestId: 'send-request-001',
    sentEvidenceId: 'sent-evidence-001',
    deliveryVerified: true,
  }, NOW);
}

function accepted(): RecruitmentOffer {
  return recordRecruitmentOfferDecision(sent(), {
    tenantId: 'tenant-001',
    expectedVersion: 5,
    decision: 'accepted',
    acceptanceEvidenceId: 'acceptance-evidence-001',
    candidateEvidenceVerified: true,
  }, NOW);
}

function migration(
  patch: Partial<Parameters<typeof restoreRecruitmentOfferFromMigration>[0]> = {},
) {
  return {
    id: 'offer-002',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    terms: { ...TERMS, workLocation: '上海', benefitsSummary: '标准福利计划' },
    expiresAt: '2026-08-01T00:00:00.000Z',
    retentionExpiresAt: '2033-08-01T00:00:00.000Z',
    status: 'approved' as const,
    approvalInstanceId: null,
    approvalHistoryId: 'approval-history-001',
    sendRequestId: null,
    sentEvidenceId: null,
    acceptanceEvidenceId: null,
    esignFlowId: null,
    signedEvidenceId: null,
    version: 3,
    createdBy: 'actor-001',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...patch,
  };
}

describe('RecruitmentOffer 领域加固', () => {
  it('创建结果规范化、深冻结且不保留未知 L4 字段', () => {
    const result = draft();
    expect(result.terms).toEqual({
      ...TERMS,
      workLocation: '上海',
      benefitsSummary: '标准福利计划',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.terms)).toBe(true);
  });

  it.each([
    ['null', null],
    ['数组', []],
    ['额外字段', { ...TERMS, bankAccount: 'forbidden' }],
    ['无原型对象', Object.assign(Object.create(null) as object, TERMS)],
    ['存取器字段', Object.defineProperty({ ...TERMS }, 'workLocation', {
      enumerable: true,
      get: () => '上海',
    })],
    ['Symbol 字段', Object.assign({ ...TERMS }, { [Symbol('secret')]: 'forbidden' })],
  ])('条款拒绝%s形态', (_name, value) => {
    expect(() => validateRecruitmentOfferTerms(
      value as RecruitmentOfferTerms,
    )).toThrow('严格字段白名单');
  });

  it.each([
    ['币种', { currency: 'USD' }],
    ['月薪小数', { monthlyBaseSalaryMinor: 1.5 }],
    ['月薪负数', { monthlyBaseSalaryMinor: -1 }],
    ['月薪为零', { monthlyBaseSalaryMinor: 0 }],
    ['奖金非安全整数', { signingBonusMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['变量薪酬负数', { annualVariableTargetMinor: -1 }],
    ['计薪月数小数', { salaryMonths: 1.5 }],
    ['计薪月数过小', { salaryMonths: 0 }],
    ['计薪月数过大', { salaryMonths: 25 }],
    ['试用期小数', { probationMonths: 1.5 }],
    ['试用期负数', { probationMonths: -1 }],
    ['试用期过大', { probationMonths: 13 }],
    ['自动滚动业务日期', { proposedStartDate: '2026-02-31' }],
    ['非闰年二月', { proposedStartDate: '2025-02-29' }],
    ['日期格式', { proposedStartDate: '2026-2-01' }],
    ['用工类型', { employmentType: 'full time' }],
    ['工作地点空白', { workLocation: '   ' }],
    ['工作地点超长', { workLocation: '上'.repeat(257) }],
    ['福利空白', { benefitsSummary: '   ' }],
    ['福利超长', { benefitsSummary: '福'.repeat(4_097) }],
  ])('条款拒绝%s', (_name, patch) => {
    expect(() => validateRecruitmentOfferTerms({
      ...TERMS,
      ...patch,
    } as RecruitmentOfferTerms)).toThrow();
  });

  it('真实闰日业务日期被接受', () => {
    expect(validateRecruitmentOfferTerms({
      ...TERMS,
      proposedStartDate: '2028-02-29',
    }).proposedStartDate).toBe('2028-02-29');
  });

  it.each([
    ['id', '../offer'],
    ['tenantId', ''],
    ['applicationId', 'application with space'],
    ['candidateId', 'candidate/001'],
    ['positionId', 'position#001'],
    ['completedInterviewId', 'interview?001'],
    ['actorId', 'actor 001'],
  ])('创建拒绝非法标识 %s', (field, value) => {
    expect(() => createRecruitmentOffer({
      id: 'offer-001',
      tenantId: 'tenant-001',
      applicationId: 'application-001',
      candidateId: 'candidate-001',
      positionId: 'position-001',
      completedInterviewId: 'interview-001',
      terms: TERMS,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'),
      actorId: 'actor-001',
      [field]: value,
    }, NOW)).toThrow('标识白名单');
  });

  it('创建拒绝非法、已到期及倒置保留时间', () => {
    expect(() => createRecruitmentOffer({
      ...draftInput(),
      expiresAt: new Date('invalid'),
    }, NOW)).toThrow('时间无效');
    expect(() => createRecruitmentOffer({
      ...draftInput(),
      expiresAt: NOW,
    }, NOW)).toThrow('有效期');
    expect(() => createRecruitmentOffer({
      ...draftInput(),
      retentionExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
    }, NOW)).toThrow('保留期');
    expect(() => createRecruitmentOffer(
      draftInput(),
      new Date('invalid'),
    )).toThrow('时间无效');
  });

  it.each([
    ['租户漂移', { tenantId: 'tenant-other' }],
    ['非法版本', { expectedVersion: 0 }],
    ['版本冲突', { expectedVersion: 2 }],
    ['非法主体', { actorId: 'actor invalid' }],
    ['非法审批引用', { approvalInstanceId: 'approval invalid' }],
    ['非创建人', { actorId: 'actor-002' }],
  ])('提交拒绝%s', (_name, patch) => {
    expect(() => submitRecruitmentOffer(draft(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      actorId: 'actor-001',
      approvalInstanceId: 'approval-001',
      ...patch,
    }, NOW)).toThrow();
  });

  it('提交拒绝非草稿与已过期 Offer', () => {
    expect(() => submitRecruitmentOffer(
      { ...draft(), status: 'approved' },
      {
        tenantId: 'tenant-001', expectedVersion: 1,
        actorId: 'actor-001', approvalInstanceId: 'approval-001',
      },
      NOW,
    )).toThrow('创建人');
    expect(() => submitRecruitmentOffer(
      { ...draft(), expiresAt: NOW.toISOString() },
      {
        tenantId: 'tenant-001', expectedVersion: 1,
        actorId: 'actor-001', approvalInstanceId: 'approval-001',
      },
      NOW,
    )).toThrow('有效期');
  });

  it.each([
    ['非法审批引用', { approvalInstanceId: 'approval invalid' }],
    ['非法结果', { outcome: 'cancelled' }],
    ['非待审批状态', { offer: draft() }],
    ['未验真', { approvalVerified: false }],
    ['引用错位', { approvalInstanceId: 'approval-002' }],
  ])('审批回写拒绝%s', (_name, patch) => {
    const { offer = pending(), ...inputPatch } = patch as {
      offer?: RecruitmentOffer;
      approvalInstanceId?: string;
      outcome?: string;
      approvalVerified?: boolean;
    };
    expect(() => applyRecruitmentOfferApprovalOutcome(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
      approvalInstanceId: 'approval-001',
      outcome: 'approved',
      approvalVerified: true,
      ...inputPatch,
    } as Parameters<typeof applyRecruitmentOfferApprovalOutcome>[1], NOW)).toThrow();
  });

  it('审批通过拒绝已到期，审批拒绝仍可形成可信终态', () => {
    const expired = { ...pending(), expiresAt: NOW.toISOString() };
    expect(() => applyRecruitmentOfferApprovalOutcome(expired, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
      outcome: 'approved', approvalVerified: true,
    }, NOW)).toThrow('有效期');
    expect(applyRecruitmentOfferApprovalOutcome(expired, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
      outcome: 'rejected', approvalVerified: true,
    }, NOW).status).toBe('rejected');
  });

  it.each([
    ['非法请求标识', { sendRequestId: 'send invalid' }],
    ['非已审批状态', { offer: draft() }],
    ['已过期', { offer: { ...approved(), expiresAt: NOW.toISOString() } }],
  ])('发送意图拒绝%s', (_name, patch) => {
    const { offer = approved(), ...inputPatch } = patch as {
      offer?: RecruitmentOffer;
      sendRequestId?: string;
    };
    expect(() => requestRecruitmentOfferSend(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
      sendRequestId: 'send-request-001',
      ...inputPatch,
    }, NOW)).toThrow();
  });

  it.each([
    ['非法请求标识', { sendRequestId: 'send invalid' }],
    ['非法证据标识', { sentEvidenceId: 'evidence invalid' }],
    ['状态错位', { offer: approved() }],
    ['未验真', { deliveryVerified: false }],
    ['请求错位', { sendRequestId: 'send-request-002' }],
    ['已过期', { offer: { ...sending(), expiresAt: NOW.toISOString() } }],
  ])('投递事实拒绝%s', (_name, patch) => {
    const { offer = sending(), ...inputPatch } = patch as {
      offer?: RecruitmentOffer;
      sendRequestId?: string;
      sentEvidenceId?: string;
      deliveryVerified?: boolean;
    };
    expect(() => recordRecruitmentOfferSent(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
      sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001',
      deliveryVerified: true,
      ...inputPatch,
    }, NOW)).toThrow();
  });

  it.each([
    ['非法证据标识', { acceptanceEvidenceId: 'evidence invalid' }],
    ['非法决定', { decision: 'cancelled' }],
    ['状态错位', { offer: sending() }],
    ['未验真', { candidateEvidenceVerified: false }],
    ['已过期', { offer: { ...sent(), expiresAt: NOW.toISOString() } }],
  ])('候选人决定拒绝%s', (_name, patch) => {
    const { offer = sent(), ...inputPatch } = patch as {
      offer?: RecruitmentOffer;
      decision?: string;
      acceptanceEvidenceId?: string;
      candidateEvidenceVerified?: boolean;
    };
    expect(() => recordRecruitmentOfferDecision(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
      decision: 'accepted',
      acceptanceEvidenceId: 'acceptance-evidence-001',
      candidateEvidenceVerified: true,
      ...inputPatch,
    } as Parameters<typeof recordRecruitmentOfferDecision>[1], NOW)).toThrow();
  });

  it('接受与拒绝决定形成不同受控终态', () => {
    expect(accepted().status).toBe('accepted');
    expect(recordRecruitmentOfferDecision(sent(), {
      tenantId: 'tenant-001', expectedVersion: 5, decision: 'declined',
      acceptanceEvidenceId: 'decline-evidence-001', candidateEvidenceVerified: true,
    }, NOW).status).toBe('declined');
  });

  it.each([
    ['非法流程标识', { esignFlowId: 'flow invalid' }],
    ['非法证据标识', { signedEvidenceId: 'evidence invalid' }],
    ['状态错位', { offer: sent() }],
    ['未验真', { esignEvidenceVerified: false }],
  ])('签署事实拒绝%s', (_name, patch) => {
    const { offer = accepted(), ...inputPatch } = patch as {
      offer?: RecruitmentOffer;
      esignFlowId?: string;
      signedEvidenceId?: string;
      esignEvidenceVerified?: boolean;
    };
    expect(() => recordRecruitmentOfferSigned(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
      esignFlowId: 'esign-flow-001',
      signedEvidenceId: 'signed-evidence-001',
      esignEvidenceVerified: true,
      ...inputPatch,
    }, NOW)).toThrow();
  });

  it.each([
    ['approved', approved()],
    ['sending', sending()],
    ['sent', sent()],
  ])('到期任务允许 %s 状态形成 expired 终态', (_status, offer) => {
    const expiredAt = new Date(offer.expiresAt);
    expect(expireRecruitmentOffer(offer, {
      tenantId: 'tenant-001',
      expectedVersion: offer.version,
    }, expiredAt).status).toBe('expired');
  });

  it('到期任务拒绝非法状态和尚未到期的 Offer', () => {
    expect(() => expireRecruitmentOffer(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1,
    }, new Date('2026-08-02T00:00:00.000Z'))).toThrow('状态迁移');
    expect(() => expireRecruitmentOffer(approved(), {
      tenantId: 'tenant-001', expectedVersion: 3,
    }, NOW)).toThrow('状态迁移');
  });

  it('状态推进拒绝版本上溢和时间倒退', () => {
    expect(() => requestRecruitmentOfferSend({
      ...approved(),
      version: Number.MAX_SAFE_INTEGER,
    }, {
      tenantId: 'tenant-001',
      expectedVersion: Number.MAX_SAFE_INTEGER,
      sendRequestId: 'send-request-001',
    }, NOW)).toThrow('安全整数上限');
    expect(() => requestRecruitmentOfferSend(approved(), {
      tenantId: 'tenant-001', expectedVersion: 3, sendRequestId: 'send-request-001',
    }, new Date(NOW.getTime() - 1))).toThrow('不能早于');
  });

  it.each([
    ['非规范创建时间', { createdAt: '2026-07-20T00:00:00Z' }],
    ['非规范更新时间', { updatedAt: 'invalid' }],
    ['创建晚于更新', { createdAt: '2026-07-22T00:00:00.000Z' }],
    ['更新超前', { updatedAt: '2026-07-30T00:00:00.000Z' }],
    ['有效期不晚于创建', { expiresAt: '2026-07-20T00:00:00.000Z' }],
    ['保留期不晚于有效期', { retentionExpiresAt: '2026-08-01T00:00:00.000Z' }],
    ['保留期已过', { retentionExpiresAt: '2026-07-21T00:00:00.000Z' }],
    ['非法可选引用', { approvalHistoryId: 'approval invalid' }],
    ['待审批缺少实例', {
      status: 'pending_approval', approvalHistoryId: null, version: 2,
    }],
    ['草稿携带审批', {
      status: 'draft', approvalHistoryId: 'approval-history-001', version: 1,
    }],
    ['双审批引用', { approvalInstanceId: 'approval-001' }],
    ['投递缺少请求', { sentEvidenceId: 'sent-evidence-001' }],
    ['决定缺少投递', { acceptanceEvidenceId: 'acceptance-evidence-001' }],
    ['签署引用不成对', { esignFlowId: 'esign-flow-001' }],
    ['签署缺少决定', {
      esignFlowId: 'esign-flow-001', signedEvidenceId: 'signed-evidence-001',
    }],
    ['状态与证据不匹配', { status: 'sent' }],
    ['版本与动作不匹配', { version: 4 }],
  ])('迁移拒绝%s', (_name, patch) => {
    expect(() => restoreRecruitmentOfferFromMigration(
      migration(patch as Partial<Parameters<typeof restoreRecruitmentOfferFromMigration>[0]>),
      new Date('2026-07-22T00:00:00.000Z'),
    )).toThrow();
  });

  it('迁移拒绝非法当前时间和未知 L4 条款字段', () => {
    expect(() => restoreRecruitmentOfferFromMigration(
      migration(),
      new Date('invalid'),
    )).toThrow('时间无效');
    expect(() => restoreRecruitmentOfferFromMigration(migration({
      terms: { ...TERMS, bankAccount: 'forbidden' } as RecruitmentOfferTerms,
    }), new Date('2026-07-22T00:00:00.000Z'))).toThrow('严格字段白名单');
  });

  it.each([
    ['draft', {
      status: 'draft', approvalHistoryId: null, version: 1,
    }],
    ['pending_approval', {
      status: 'pending_approval', approvalInstanceId: 'approval-001',
      approvalHistoryId: null, version: 2,
    }],
    ['sending', {
      status: 'sending', sendRequestId: 'send-request-001', version: 4,
    }],
    ['sent', {
      status: 'sent', sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001', version: 5,
    }],
    ['accepted', {
      status: 'accepted', sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001',
      acceptanceEvidenceId: 'acceptance-evidence-001', version: 6,
    }],
    ['signed', {
      status: 'signed', sendRequestId: 'send-request-001',
      sentEvidenceId: 'sent-evidence-001',
      acceptanceEvidenceId: 'acceptance-evidence-001',
      esignFlowId: 'esign-flow-001', signedEvidenceId: 'signed-evidence-001', version: 7,
    }],
    ['expired', {
      status: 'expired', version: 4,
    }],
  ])('迁移接受严格闭合的 %s 快照', (status, patch) => {
    expect(restoreRecruitmentOfferFromMigration(
      migration(patch as Partial<Parameters<typeof restoreRecruitmentOfferFromMigration>[0]>),
      new Date('2026-07-22T00:00:00.000Z'),
    ).status).toBe(status);
  });
});

function draftInput(): Parameters<typeof createRecruitmentOffer>[0] {
  return {
    id: 'offer-001',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    candidateId: 'candidate-001',
    positionId: 'position-001',
    completedInterviewId: 'interview-001',
    terms: TERMS,
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'),
    actorId: 'actor-001',
  };
}
