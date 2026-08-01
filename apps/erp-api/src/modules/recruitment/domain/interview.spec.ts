import { describe, expect, it } from 'vitest';

import {
  cancelRecruitmentInterview,
  completeRecruitmentInterview,
  createRecruitmentInterview,
  restoreRecruitmentInterviewFromMigration,
  submitRecruitmentInterviewFeedback,
} from './interview.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');
const DURING_INTERVIEW = new Date('2026-07-22T08:30:00.000Z');
const AFTER_INTERVIEW = new Date('2026-07-22T09:05:00.000Z');

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
    }, DURING_INTERVIEW);
    expect(feedback.feedback).toMatchObject({ interviewerId: 'employee-001', score: 4 });
    expect(feedback.interview).toMatchObject({ version: 2, status: 'scheduled' });
    expect(Object.isFrozen(feedback)).toBe(true);
    expect(() => submitRecruitmentInterviewFeedback(interview(), {
      id: 'feedback-002', tenantId: 'tenant-001', interviewerId: 'employee-003',
      expectedVersion: 1,
      recommendation: 'hire', score: 4, notes: '越权评价',
    }, DURING_INTERVIEW)).toThrowError(/RECRUITMENT_FEEDBACK_SUBMIT_DENIED|\u53ea有/u);
  });

  it('全部面试官提交后才可完成，取消与完成均为终态', () => {
    expect(() => completeRecruitmentInterview(interview(), {
      tenantId: 'tenant-001', expectedVersion: 1,
      submittedInterviewerIds: ['employee-001'],
    }, AFTER_INTERVIEW)).toThrowError(/RECRUITMENT_FEEDBACK_INCOMPLETE|所有/u);
    const completed = completeRecruitmentInterview(interview(), {
      tenantId: 'tenant-001', expectedVersion: 1,
      submittedInterviewerIds: ['employee-001', 'employee-002'],
    }, AFTER_INTERVIEW);
    expect(completed).toMatchObject({ status: 'completed', version: 2 });
    expect(() => cancelRecruitmentInterview(completed, {
      tenantId: 'tenant-001', expectedVersion: 2,
    }, AFTER_INTERVIEW)).toThrowError(/RECRUITMENT_INTERVIEW_CANCEL_INVALID|只有/u);
  });

  it('迁移以内存状态机恢复历史面试和不可变评价', () => {
    const restored = restoreRecruitmentInterviewFromMigration({
      id: 'interview-003', tenantId: 'tenant-001', applicationId: 'application-001',
      roundNumber: 1, mode: 'onsite', startsAt: '2026-07-20T08:00:00.000Z',
      endsAt: '2026-07-20T09:00:00.000Z', timezone: 'Asia/Shanghai',
      interviewerIds: ['employee-001', 'employee-002'], location: '上海总部 8F',
      createdBy: 'employee-hr',
      feedback: [
        {
          id: 'feedback-003', interviewerId: 'employee-001', recommendation: 'hire',
          score: 4, notes: '岗位经验匹配', submittedAt: '2026-07-20T09:01:00.000Z',
        },
        {
          id: 'feedback-004', interviewerId: 'employee-002', recommendation: 'strong_hire',
          score: 5, notes: '综合能力优秀', submittedAt: '2026-07-20T09:02:00.000Z',
        },
      ],
      expectedStatus: 'completed', expectedVersion: 4,
      completedAt: '2026-07-20T09:03:00.000Z', cancelledAt: null,
      createdAt: '2026-07-19T08:00:00.000Z', updatedAt: '2026-07-20T09:03:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'));
    expect(restored.interview).toMatchObject({ status: 'completed', version: 4 });
    expect(restored.feedback).toHaveLength(2);
    expect(restored.feedback[0]).toMatchObject({
      interviewerId: 'employee-001', recommendation: 'hire', score: 4,
    });
  });

  it('迁移拒绝跳过面试官评价或伪造控制版本', () => {
    expect(() => restoreRecruitmentInterviewFromMigration({
      id: 'interview-004', tenantId: 'tenant-001', applicationId: 'application-001',
      roundNumber: 1, mode: 'video', startsAt: '2026-07-20T08:00:00.000Z',
      endsAt: '2026-07-20T09:00:00.000Z', timezone: 'Asia/Shanghai',
      interviewerIds: ['employee-001', 'employee-002'], location: '加密会议室',
      createdBy: 'employee-hr',
      feedback: [{
        id: 'feedback-005', interviewerId: 'employee-001', recommendation: 'hire',
        score: 4, notes: '只有一份评价', submittedAt: '2026-07-20T09:01:00.000Z',
      }],
      expectedStatus: 'completed', expectedVersion: 3,
      completedAt: '2026-07-20T09:03:00.000Z', cancelledAt: null,
      createdAt: '2026-07-19T08:00:00.000Z', updatedAt: '2026-07-20T09:03:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrowError(
      /RECRUITMENT_FEEDBACK_INCOMPLETE|所有面试官/u,
    );
  });
});
