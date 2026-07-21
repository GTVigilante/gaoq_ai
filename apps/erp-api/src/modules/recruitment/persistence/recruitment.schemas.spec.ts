import { Mongoose, type Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  CandidateApplicationRecordSchema,
  CandidateApplicationStageRecordSchema,
  CandidateConsentEvidenceRecordSchema,
  RecruitmentCandidateRecordSchema,
  RecruitmentInterviewFeedbackRecordSchema,
  RecruitmentInterviewRecordSchema,
  RecruitmentOfferRecordSchema,
  RecruitmentPositionRecordSchema,
  RecruitmentRequisitionRecordSchema,
  type CandidateApplicationRecord,
  type RecruitmentCandidateRecord,
  type RecruitmentInterviewFeedbackRecord,
  type RecruitmentInterviewRecord,
  type RecruitmentOfferRecord,
  type RecruitmentPositionRecord,
  type RecruitmentRequisitionRecord,
} from './recruitment.schemas.js';

const mongoose = new Mongoose();
const CandidateModel = mongoose.model<RecruitmentCandidateRecord>(
  'SpecRecruitmentCandidate', RecruitmentCandidateRecordSchema,
);
const ApplicationModel = mongoose.model<CandidateApplicationRecord>(
  'SpecCandidateApplication', CandidateApplicationRecordSchema,
);
const PositionModel = mongoose.model<RecruitmentPositionRecord>(
  'SpecRecruitmentPosition', RecruitmentPositionRecordSchema,
);
const RequisitionModel = mongoose.model<RecruitmentRequisitionRecord>(
  'SpecRecruitmentRequisition', RecruitmentRequisitionRecordSchema,
);
const InterviewModel = mongoose.model<RecruitmentInterviewRecord>(
  'SpecRecruitmentInterview', RecruitmentInterviewRecordSchema,
);
const FeedbackModel = mongoose.model<RecruitmentInterviewFeedbackRecord>(
  'SpecRecruitmentInterviewFeedback', RecruitmentInterviewFeedbackRecordSchema,
);
const OfferModel = mongoose.model<RecruitmentOfferRecord>(
  'SpecRecruitmentOffer', RecruitmentOfferRecordSchema,
);

const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const REQUISITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';

function candidate(): Record<string, unknown> {
  return {
    id: CANDIDATE_ID,
    tenantId: 'tenant-001',
    status: 'active',
    identityKeyId: 'recruitment-key-001',
    identityIv: 'a'.repeat(16),
    identityCiphertext: 'b'.repeat(64),
    identityAuthTag: 'c'.repeat(22),
    phoneBlindIndexes: [`blind-key-001.${'d'.repeat(43)}`],
    emailBlindIndexes: [`blind-key-001.${'e'.repeat(43)}`],
    consent: {
      evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
      version: 'privacy-v1', purpose: '招聘评估与候选人联络', source: 'portal',
      capturedAt: new Date('2026-07-21T08:00:00.000Z'),
      expiresAt: new Date('2027-07-21T08:00:00.000Z'), withdrawnAt: null,
    },
    retentionExpiresAt: new Date('2028-07-21T08:00:00.000Z'),
    version: 1,
  };
}

function application(): Record<string, unknown> {
  return {
    id: APPLICATION_ID,
    tenantId: 'tenant-001',
    candidateId: CANDIDATE_ID,
    positionId: POSITION_ID,
    consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
    sourceChannel: 'portal',
    stage: 'applied',
    active: true,
    completedInterviewId: null,
    offerId: null,
    acceptanceEvidenceId: null,
    onboardingInstanceId: null,
    employmentId: null,
    version: 1,
    appliedAt: new Date('2026-07-21T08:00:00.000Z'),
    endedAt: null,
  };
}

function position(): Record<string, unknown> {
  return {
    id: POSITION_ID,
    tenantId: 'tenant-001',
    requisitionId: REQUISITION_ID,
    title: '小红书经纪人',
    departmentId: 'department-001',
    jobLevelId: 'job-level-001',
    location: '上海',
    headcount: 2,
    status: 'draft',
    version: 1,
    publishedAt: null,
    closedAt: null,
  };
}

describe('RecruitmentSchemas', () => {
  it('候选人集合不定义姓名、手机、邮箱、简历明文字段或明文摘要', async () => {
    await new CandidateModel(candidate()).validate();
    for (const field of ['name', 'phone', 'email', 'resume', 'resumeText', 'identityDigest']) {
      expect(RecruitmentCandidateRecordSchema.path(field)).toBeUndefined();
    }
    expect(RecruitmentCandidateRecordSchema.path('identityCiphertext')).toBeDefined();
    expect(RecruitmentCandidateRecordSchema.path('phoneBlindIndexes')).toBeDefined();
  });

  it('匿名化必须同时销毁密文和盲索引，授权撤回必须留时间', async () => {
    await expect(new CandidateModel({
      ...candidate(), status: 'anonymized', phoneBlindIndexes: [], emailBlindIndexes: [],
    }).validate()).rejects.toThrow('不能保留身份密文');
    await new CandidateModel({
      ...candidate(), status: 'anonymized',
      identityKeyId: null, identityIv: null, identityCiphertext: null, identityAuthTag: null,
      phoneBlindIndexes: [], emailBlindIndexes: [],
    }).validate();
    await expect(new CandidateModel({
      ...candidate(), status: 'consent_withdrawn',
    }).validate()).rejects.toThrow('必须记录撤回时间');
  });

  it('申请阶段证据和终态时间在持久层再次失败关闭', async () => {
    await new ApplicationModel(application()).validate();
    await expect(new ApplicationModel({
      ...application(), stage: 'offer_sent', version: 5,
    }).validate()).rejects.toThrow('必须引用已完成面试');
    await expect(new ApplicationModel({
      ...application(), stage: 'rejected', version: 2,
    }).validate()).rejects.toThrow('终态与结束时间不一致');
  });

  it('职位发布和 HC 审批引用保持状态一致', async () => {
    await new PositionModel(position()).validate();
    await new PositionModel({
      ...position(), status: 'closed', closedAt: new Date('2026-07-21T09:00:00.000Z'),
    }).validate();
    await expect(new PositionModel({
      ...position(), status: 'open', publishedAt: null,
    }).validate()).rejects.toThrow('必须记录首次发布时间');
    await new RequisitionModel({
      id: REQUISITION_ID, tenantId: 'tenant-001', departmentId: 'department-001',
      positionTitle: '小红书经纪人', headcount: 2, justification: '业务增长需要补充招聘人数',
      status: 'draft', approvalInstanceId: null, version: 1, createdBy: 'actor-001',
    }).validate();
    await expect(new RequisitionModel({
      id: REQUISITION_ID, tenantId: 'tenant-001', departmentId: 'department-001',
      positionTitle: '小红书经纪人', headcount: 2, justification: '业务增长需要补充招聘人数',
      status: 'approved', approvalInstanceId: null, version: 2, createdBy: 'actor-001',
    }).validate()).rejects.toThrow('审批实例引用不一致');
  });

  it('面试地点与评价只定义密文字段，终态时间失败关闭', async () => {
    const encrypted = {
      keyId: 'recruitment-key-001', iv: 'a'.repeat(16),
      ciphertext: 'b'.repeat(64), authTag: 'c'.repeat(22),
    };
    const interview = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X1', tenantId: 'tenant-001',
      applicationId: APPLICATION_ID, roundNumber: 1, mode: 'video',
      startsAt: new Date('2026-07-22T08:00:00.000Z'),
      endsAt: new Date('2026-07-22T09:00:00.000Z'), timezone: 'Asia/Shanghai',
      interviewerIds: ['employee-001'], logisticsKeyId: encrypted.keyId,
      logisticsIv: encrypted.iv, logisticsCiphertext: encrypted.ciphertext,
      logisticsAuthTag: encrypted.authTag, status: 'scheduled', version: 1,
      completedAt: null, cancelledAt: null, createdBy: 'actor-001',
    };
    await new InterviewModel(interview).validate();
    await expect(new InterviewModel({
      ...interview, status: 'completed', completedAt: null,
    }).validate()).rejects.toThrow('完成状态与完成时间不一致');
    await new FeedbackModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X2', tenantId: 'tenant-001',
      interviewId: interview.id, interviewerId: 'employee-001',
      evaluationKeyId: encrypted.keyId, evaluationIv: encrypted.iv,
      evaluationCiphertext: encrypted.ciphertext, evaluationAuthTag: encrypted.authTag,
      submittedAt: new Date('2026-07-22T09:01:00.000Z'),
    }).validate();
    expect(RecruitmentInterviewRecordSchema.path('location')).toBeUndefined();
    expect(RecruitmentInterviewFeedbackRecordSchema.path('notes')).toBeUndefined();
    expect(RecruitmentInterviewFeedbackRecordSchema.path('recommendation')).toBeUndefined();
    expect(RecruitmentInterviewFeedbackRecordSchema.path('score')).toBeUndefined();
  });

  it('Offer 条款只保存 L4 密文且所有状态证据失败关闭', async () => {
    const offer = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X3', tenantId: 'tenant-001',
      applicationId: APPLICATION_ID, candidateId: CANDIDATE_ID, positionId: POSITION_ID,
      completedInterviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
      termsKeyId: 'recruitment-key-001', termsIv: 'a'.repeat(16),
      termsCiphertext: 'b'.repeat(64), termsAuthTag: 'c'.repeat(22),
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'),
      status: 'draft', approvalInstanceId: null, sendRequestId: null,
      sentEvidenceId: null, acceptanceEvidenceId: null, esignFlowId: null,
      signedEvidenceId: null, version: 1, createdBy: 'actor-001',
    };
    await new OfferModel(offer).validate();
    await expect(new OfferModel({
      ...offer, status: 'sent', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4X4',
    }).validate()).rejects.toThrow('发送请求');
    await expect(new OfferModel({
      ...offer, status: 'signed', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4X4',
      sendRequestId: 'send-request-001', sentEvidenceId: 'sent-evidence-001',
      acceptanceEvidenceId: 'accept-evidence-001', esignFlowId: 'esign-flow-001',
    }).validate()).rejects.toThrow('eSign');
    for (const field of [
      'terms', 'currency', 'monthlyBaseSalaryMinor', 'benefitsSummary', 'workLocation',
    ]) expect(RecruitmentOfferRecordSchema.path(field)).toBeUndefined();
    expect(RecruitmentOfferRecordSchema.path('termsCiphertext')).toBeDefined();
  });

  it('全部业务索引以 tenantId 开头，盲索引唯一且密文不建索引', () => {
    const schemas: readonly Schema[] = [
      RecruitmentCandidateRecordSchema,
      CandidateConsentEvidenceRecordSchema,
      RecruitmentRequisitionRecordSchema,
      RecruitmentPositionRecordSchema,
      CandidateApplicationRecordSchema,
      CandidateApplicationStageRecordSchema,
      RecruitmentInterviewRecordSchema,
      RecruitmentInterviewFeedbackRecordSchema,
      RecruitmentOfferRecordSchema,
    ];
    for (const schema of schemas) {
      for (const [spec] of schema.indexes()) {
        expect(Object.keys(spec)[0]).toBe('tenantId');
        expect(spec).not.toHaveProperty('identityCiphertext');
      }
    }
    const phoneIndex = RecruitmentCandidateRecordSchema.indexes()
      .find(([spec]) => spec.phoneBlindIndexes === 1);
    const emailIndex = RecruitmentCandidateRecordSchema.indexes()
      .find(([spec]) => spec.emailBlindIndexes === 1);
    const requisitionPositionIndex = RecruitmentPositionRecordSchema.indexes()
      .find(([spec]) => spec.requisitionId === 1);
    expect(phoneIndex?.[1]).toMatchObject({ unique: true, sparse: true });
    expect(emailIndex?.[1]).toMatchObject({ unique: true, sparse: true });
    expect(requisitionPositionIndex?.[1]).toMatchObject({ unique: true });
  });
});
