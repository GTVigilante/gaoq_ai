import { describe, expect, it } from 'vitest';

import {
  completeTrainingAssignment,
  createCourseVersion,
  createExamAttempt,
  createTrainingAssignment,
  publishCourseVersion,
  recordTrainingProgress,
  retireCourseVersion,
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
    expect(course).toMatchObject({
      questionMode: 'objective',
      timeLimitMinutes: 60,
      maxAttempts: 3,
      gradingPolicyVersion: 'objective-auto-v1',
      manualReviewRequired: false,
    });
    expect(() => publishCourseVersion(course, {
      tenantId: 'tenant-001', expectedVersion: 1,
      contentVerified: true, questionBankVerified: false,
    }, NOW)).toThrow(/题库/);
    expect(publishCourseVersion(course, {
      tenantId: 'tenant-001', expectedVersion: 1,
      contentVerified: true, questionBankVerified: true,
    }, NOW).status).toBe('published');
  });

  it('主观题和混合题强制进入人工复核且考试策略必须绑定题库', () => {
    const subjective = createCourseVersion({
      id: 'course-version-001', tenantId: 'tenant-001', courseCode: 'LEADERSHIP',
      revision: 1, title: '管理能力', contentRef: 'content-001',
      questionBankRef: 'question-bank-001', questionBankDigest: 'a'.repeat(43),
      passingScoreBps: 7_000, questionMode: 'subjective',
      timeLimitMinutes: 90, maxAttempts: 2, gradingPolicyVersion: 'manual-v2',
    }, NOW);
    expect(subjective).toMatchObject({
      questionMode: 'subjective',
      timeLimitMinutes: 90,
      maxAttempts: 2,
      gradingPolicyVersion: 'manual-v2',
      manualReviewRequired: true,
    });
    expect(() => createCourseVersion({
      id: 'course-version-002', tenantId: 'tenant-001', courseCode: 'INVALID',
      revision: 1, title: '非法策略', contentRef: 'content-002',
      questionMode: 'mixed',
    }, NOW)).toThrow(/不能配置考试策略/);
    expect(() => createCourseVersion({
      id: 'course-version-003', tenantId: 'tenant-001', courseCode: 'INVALID',
      revision: 1, title: '非法次数', contentRef: 'content-003',
      questionBankRef: 'question-bank-003', questionBankDigest: 'b'.repeat(43),
      passingScoreBps: 7_000, maxAttempts: 11,
    }, NOW)).toThrow(/最大考试次数/);
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

  it('分项通过策略必须使用签名结论且拒绝阈值策略矛盾结论', () => {
    expect(() => createExamAttempt({
      id: 'attempt-001',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      attemptNumber: 1,
      submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: 'grading-001',
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-manual-v2',
      passingRule: 'all_required_sections',
      manualReviewEvidenceId: 'review-001',
      scoreBps: 8_500,
      passingScoreBps: 8_000,
      serverGradingVerified: true,
    }, NOW)).toThrow(/受信通过结论/u);
    expect(() => createExamAttempt({
      id: 'attempt-002',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      attemptNumber: 1,
      submissionRef: 'submission-002',
      questionSetDigest: 'b'.repeat(43),
      gradingEvidenceId: 'grading-002',
      passingRule: 'score_threshold',
      scoreBps: 7_000,
      passingScoreBps: 8_000,
      passedOverride: true,
      serverGradingVerified: true,
    }, NOW)).toThrow(/阈值策略不一致/u);
  });

  it('任职受众至少配置一个维度，配置两维时完整保留并仅允许发布后下架', () => {
    expect(() => createCourseVersion({
      id: 'course-version-001',
      tenantId: 'tenant-001',
      courseCode: 'SECURITY',
      revision: 1,
      title: '信息安全',
      contentRef: 'content-001',
      audienceMode: 'employment_scope',
      audienceDepartmentIds: [],
      audiencePositionIds: [],
    }, NOW)).toThrow(/至少配置一个部门或岗位/);
    const draft = createCourseVersion({
      id: 'course-version-001',
      tenantId: 'tenant-001',
      courseCode: 'SECURITY',
      revision: 1,
      title: '信息安全',
      contentRef: 'content-001',
      audienceMode: 'employment_scope',
      audienceDepartmentIds: ['department-001'],
      audiencePositionIds: ['position-001'],
    }, NOW);
    expect(draft).toMatchObject({
      audienceMode: 'employment_scope',
      audienceDepartmentIds: ['department-001'],
      audiencePositionIds: ['position-001'],
    });
    expect(() => retireCourseVersion(draft, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
    }, NOW)).toThrow(/只能下架已发布课程/);
    const published = publishCourseVersion(draft, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      contentVerified: true,
      questionBankVerified: true,
    }, NOW);
    expect(retireCourseVersion(published, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
    }, NOW)).toMatchObject({ status: 'retired', version: 3 });
  });
});
