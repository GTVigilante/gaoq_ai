import { describe, expect, it } from 'vitest';

import {
  cancelRecruitmentInterview,
  completeRecruitmentInterview,
  createRecruitmentInterview,
  submitRecruitmentInterviewFeedback,
} from './interview.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');

function interview() {
  return createRecruitmentInterview({
    id: 'interview-001', tenantId: 'tenant-001', applicationId: 'application-001',
    roundNumber: 1, mode: 'video', startsAt: new Date('2026-07-22T08:00:00.000Z'),
    endsAt: new Date('2026-07-22T09:00:00.000Z'), timezone: 'Asia/Shanghai',
    interviewerIds: ['employee-001', 'employee-002'],
    location: 'https://meeting.example/protected-room', actorId: 'actor-001',
  }, NOW);
}

describe('RecruitmentInterview', () => {
  it('创建时校验时间、时区和唯一面试官', () => {
    expect(interview()).toMatchObject({ status: 'scheduled', version: 1, roundNumber: 1 });
    expect(() => createRecruitmentInterview({
      id: 'interview-002', tenantId: 'tenant-001', applicationId: 'application-001',
      roundNumber: 2, mode: 'video', startsAt: new Date('2026-07-22T09:00:00.000Z'),
      endsAt: new Date('2026-07-22T08:00:00.000Z'), timezone: 'CST',
      interviewerIds: ['employee-001', 'employee-001'], location: 'room', actorId: 'actor-001',
    }, NOW)).toThrow();
  });

  it('只有本轮面试官可提交自己的不可变评价', () => {
    const feedback = submitRecruitmentInterviewFeedback(interview(), {
      id: 'feedback-001', tenantId: 'tenant-001', interviewerId: 'employee-001',
      expectedVersion: 1,
      recommendation: 'hire', score: 4, notes: '能力符合要求，建议进入下一轮',
    }, NOW);
    expect(feedback.feedback).toMatchObject({ interviewerId: 'employee-001', score: 4 });
    expect(feedback.interview).toMatchObject({ version: 2, status: 'scheduled' });
    expect(Object.isFrozen(feedback)).toBe(true);
    expect(() => submitRecruitmentInterviewFeedback(interview(), {
      id: 'feedback-002', tenantId: 'tenant-001', interviewerId: 'employee-003',
      expectedVersion: 1,
      recommendation: 'hire', score: 4, notes: '越权评价',
    }, NOW)).toThrowError(/RECRUITMENT_FEEDBACK_SUBMIT_DENIED|\u53ea有/u);
  });

  it('全部面试官提交后才可完成，取消与完成均为终态', () => {
    expect(() => completeRecruitmentInterview(interview(), {
      tenantId: 'tenant-001', expectedVersion: 1,
      submittedInterviewerIds: ['employee-001'],
    }, NOW)).toThrowError(/RECRUITMENT_FEEDBACK_INCOMPLETE|所有/u);
    const completed = completeRecruitmentInterview(interview(), {
      tenantId: 'tenant-001', expectedVersion: 1,
      submittedInterviewerIds: ['employee-001', 'employee-002'],
    }, NOW);
    expect(completed).toMatchObject({ status: 'completed', version: 2 });
    expect(() => cancelRecruitmentInterview(completed, {
      tenantId: 'tenant-001', expectedVersion: 2,
    }, NOW)).toThrowError(/RECRUITMENT_INTERVIEW_CANCEL_INVALID|只有/u);
  });
});
