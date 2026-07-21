import { describe, expect, it } from 'vitest';

import { createCandidateApplication, transitionCandidateApplication } from './application.js';
import { createRecruitmentPosition } from './position.js';
import { createRecruitmentInterview, submitRecruitmentInterviewFeedback } from './interview.js';
import { createRecruitmentOffer } from './offer.js';
import {
  buildCandidateApplicationCreatedEvent,
  buildCandidateApplicationStageEvent,
  buildRecruitmentPositionEvent,
  buildRecruitmentRequisitionEvent,
  buildRecruitmentInterviewEvent,
  buildRecruitmentInterviewFeedbackEvent,
  buildRecruitmentOfferEvent,
} from './recruitment-events.js';
import { createRecruitmentRequisition } from './requisition.js';

describe('RecruitmentDomainEvents', () => {
  it('创建和阶段事件不含候选人原文或 Offer 敏感条款', () => {
    const application = createCandidateApplication({
      id: 'application-001', tenantId: 'tenant-001', candidateId: 'candidate-001',
      positionId: 'position-001', consentEvidenceId: 'consent-evidence-001',
      sourceChannel: 'portal',
    }, new Date('2026-07-21T08:00:00.000Z'));
    const transition = transitionCandidateApplication(application, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      targetStage: 'screening',
    }, new Date('2026-07-21T09:00:00.000Z'));
    const events = [
      buildCandidateApplicationCreatedEvent(application),
      buildCandidateApplicationStageEvent(transition.event),
    ];
    expect(events[0]).toMatchObject({
      type: 'recruitment.application.created', version: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'recruitment.application.stage_changed', version: 2,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /name|phone|mobile|email|resume|salary|benefit|identityCiphertext/iu,
    );
  });

  it('HC 和职位事件使用独立聚合类型且不携带申请原文', () => {
    const now = new Date('2026-07-21T08:00:00.000Z');
    const requisition = createRecruitmentRequisition({
      id: 'requisition-001', tenantId: 'tenant-001', departmentId: 'department-001',
      positionTitle: '小红书经纪人', headcount: 2,
      justification: '业务增长需要补充招聘人数', actorId: 'actor-001',
    }, now);
    const position = createRecruitmentPosition({
      id: 'position-001', tenantId: 'tenant-001', requisitionId: requisition.id,
      title: requisition.positionTitle, departmentId: requisition.departmentId,
      jobLevelId: 'job-level-001', location: '上海', headcount: requisition.headcount,
    }, now);
    const events = [
      buildRecruitmentRequisitionEvent(requisition, 'created'),
      buildRecruitmentPositionEvent(position, 'created'),
    ];
    expect(events[0]).toMatchObject({
      type: 'recruitment.requisition.created', aggregateType: 'recruitment.requisition',
      aggregateId: requisition.id, version: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'recruitment.position.created', aggregateType: 'recruitment.position',
      aggregateId: position.id, version: 1,
    });
    expect(JSON.stringify(events)).not.toMatch(/小红书经纪人|业务增长|上海/u);
  });

  it('面试和评价事件不泄漏会议链接或评价原文', () => {
    const now = new Date('2026-07-21T08:00:00.000Z');
    const interview = createRecruitmentInterview({
      id: 'interview-001', tenantId: 'tenant-001', applicationId: 'application-001',
      roundNumber: 1, mode: 'video', startsAt: new Date('2026-07-22T08:00:00.000Z'),
      endsAt: new Date('2026-07-22T09:00:00.000Z'), timezone: 'Asia/Shanghai',
      interviewerIds: ['employee-001'], location: 'https://meeting.example/secret',
      actorId: 'actor-001',
    }, now);
    const feedback = submitRecruitmentInterviewFeedback(interview, {
      id: 'feedback-001', tenantId: 'tenant-001', interviewerId: 'employee-001',
      expectedVersion: 1,
      recommendation: 'hire', score: 4, notes: '候选人能力匹配，建议继续',
    }, now);
    const events = [
      buildRecruitmentInterviewEvent(interview, 'scheduled'),
      buildRecruitmentInterviewFeedbackEvent(feedback.interview, feedback.feedback),
    ];
    expect(events[0]).toMatchObject({
      type: 'recruitment.interview.scheduled', aggregateType: 'recruitment.interview',
    });
    expect(events[1]).toMatchObject({ type: 'recruitment.interview.feedback_submitted' });
    expect(JSON.stringify(events)).not.toMatch(
      /meeting\.example|候选人能力匹配|location|notes|recommendation|score|"hire"/iu,
    );
  });

  it('Offer 事件只携带状态与证据引用，不携带 L4 条款', () => {
    const offer = createRecruitmentOffer({
      id: 'offer-001', tenantId: 'tenant-001', applicationId: 'application-001',
      candidateId: 'candidate-001', positionId: 'position-001',
      completedInterviewId: 'interview-001',
      terms: {
        currency: 'CNY', monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
        annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
        proposedStartDate: '2026-08-15', probationMonths: 3,
        employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
      },
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
    }, new Date('2026-07-21T00:00:00.000Z'));
    const event = buildRecruitmentOfferEvent(offer, 'created');
    expect(event).toMatchObject({
      type: 'recruitment.offer.created', aggregateType: 'recruitment.offer',
      payload: { applicationId: 'application-001', status: 'draft' },
    });
    expect(JSON.stringify(event)).not.toMatch(
      /salary|currency|benefit|workLocation|标准福利计划|3000000|candidate-001/iu,
    );
  });
});
