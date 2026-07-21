import { describe, expect, it } from 'vitest';

import {
  completeTrainingAssignment,
  createCourseVersion,
  createExamAttempt,
  createTrainingAssignment,
  publishCourseVersion,
  recordTrainingProgress,
} from './training.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

describe('Knowledge 培训与考试领域', () => {
  it('题库配置必须完整且发布前经过受信任校验', () => {
    const course = createCourseVersion({
      id: 'course-version-001', tenantId: 'tenant-001', courseCode: 'SECURITY',
      revision: 1, title: '信息安全', contentRef: 'content-001',
      questionBankRef: 'question-bank-001', questionBankDigest: 'a'.repeat(43),
      passingScoreBps: 8_000,
    }, NOW);
    expect(() => publishCourseVersion(course, {
      tenantId: 'tenant-001', expectedVersion: 1,
      contentVerified: true, questionBankVerified: false,
    }, NOW)).toThrow(/题库/);
    expect(publishCourseVersion(course, {
      tenantId: 'tenant-001', expectedVersion: 1,
      contentVerified: true, questionBankVerified: true,
    }, NOW).status).toBe('published');
  });

  it('进度不能回退，完成考试课程必须引用服务端评分通过的尝试', () => {
    const assignment = createTrainingAssignment({
      id: 'assignment-001', tenantId: 'tenant-001', onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-version-001', mandatory: true, examRequired: true,
      dueDate: '2026-08-31', coursePublished: true,
    }, NOW);
    const progressed = recordTrainingProgress(assignment, {
      tenantId: 'tenant-001', expectedVersion: 1, progressBps: 10_000,
    }, NOW);
    expect(() => recordTrainingProgress(progressed, {
      tenantId: 'tenant-001', expectedVersion: 2, progressBps: 9_000,
    }, NOW)).toThrow(/不能回退/);
    const attempt = createExamAttempt({
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: assignment.id,
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      scoreBps: 8_500, passingScoreBps: 8_000, serverGradingVerified: true,
    }, NOW);
    const completed = completeTrainingAssignment(progressed, {
      tenantId: 'tenant-001', expectedVersion: 2,
      completionEvidenceId: 'completion-001', passedExamAttemptId: attempt.id,
      examPassedVerified: attempt.passed,
    }, NOW);
    expect(completed).toMatchObject({ status: 'completed', passedExamAttemptId: 'attempt-001' });
    expect(attempt).not.toHaveProperty('answers');
    expect(attempt).not.toHaveProperty('correctAnswers');
  });

  it('拒绝客户端自报考试成绩', () => {
    expect(() => createExamAttempt({
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      scoreBps: 10_000, passingScoreBps: 8_000, serverGradingVerified: false,
    }, NOW)).toThrow(/服务端评分器/);
  });
});
