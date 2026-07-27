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
const COURSE_INPUT: Parameters<typeof createCourseVersion>[0] = {
  id: 'course-version-001',
  tenantId: 'tenant-001',
  courseCode: 'SECURITY',
  revision: 1,
  title: '信息安全',
  contentRef: 'content-001',
};
const ASSIGNMENT_INPUT: Parameters<typeof createTrainingAssignment>[0] = {
  id: 'assignment-001',
  tenantId: 'tenant-001',
  onboardingInstanceId: 'onboarding-001',
  courseVersionId: 'course-version-001',
  mandatory: true,
  examRequired: true,
  dueDate: '2026-08-31',
  coursePublished: true,
};
const ATTEMPT_INPUT: Parameters<typeof createExamAttempt>[0] = {
  id: 'attempt-001',
  tenantId: 'tenant-001',
  assignmentId: 'assignment-001',
  attemptNumber: 1,
  submissionRef: 'submission-001',
  questionSetDigest: 'b'.repeat(43),
  gradingEvidenceId: 'grading-001',
  scoreBps: 8_500,
  passingScoreBps: 8_000,
  serverGradingVerified: true,
};

function draftCourse(
  override: Partial<Parameters<typeof createCourseVersion>[0]> = {},
) {
  return createCourseVersion({ ...COURSE_INPUT, ...override }, NOW);
}

function assignment(
  override: Partial<Parameters<typeof createTrainingAssignment>[0]> = {},
) {
  return createTrainingAssignment({ ...ASSIGNMENT_INPUT, ...override }, NOW);
}

function expectDomainError(operation: () => unknown, code: string): void {
  let captured: unknown;
  try {
    operation();
  } catch (error) {
    captured = error;
  }
  expect(captured).toMatchObject({ code });
}

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

  it.each([
    ['标识为空', { id: '' }, 'KNOWLEDGE_ID_INVALID'],
    ['课程编码非法', { courseCode: '含空格' }, 'KNOWLEDGE_COURSE_CODE_INVALID'],
    ['修订号非正整数', { revision: 0 }, 'KNOWLEDGE_REVISION_INVALID'],
    ['标题为空', { title: '　' }, 'KNOWLEDGE_TITLE_INVALID'],
    ['标题超长', { title: '课'.repeat(129) }, 'KNOWLEDGE_TITLE_INVALID'],
    [
      '考试基础配置不完整',
      { questionBankRef: 'question-bank-001' },
      'KNOWLEDGE_EXAM_CONFIG_INCOMPLETE',
    ],
    [
      '题库摘要非法',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'invalid',
        passingScoreBps: 8_000,
      },
      'KNOWLEDGE_QUESTION_DIGEST_INVALID',
    ],
    [
      '及格分越界',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 10_001,
      },
      'KNOWLEDGE_BPS_INVALID',
    ],
    [
      '答题时限越界',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 8_000,
        timeLimitMinutes: 4,
      },
      'KNOWLEDGE_EXAM_TIME_LIMIT_INVALID',
    ],
    [
      '评分策略版本非法',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 8_000,
        gradingPolicyVersion: 'x',
      },
      'KNOWLEDGE_GRADING_POLICY_VERSION_INVALID',
    ],
    [
      '通过规则非法',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 8_000,
        passingRule: 'unknown' as never,
      },
      'KNOWLEDGE_PASSING_RULE_INVALID',
    ],
    [
      '自动评分 SLA 越界',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 8_000,
        gradingSlaMinutes: 61,
      },
      'KNOWLEDGE_GRADING_SLA_INVALID',
    ],
    [
      '人工复核 SLA 越界',
      {
        questionBankRef: 'question-bank-001',
        questionBankDigest: 'a'.repeat(43),
        passingScoreBps: 8_000,
        manualReviewSlaMinutes: 29,
      },
      'KNOWLEDGE_MANUAL_REVIEW_SLA_INVALID',
    ],
    [
      '已分配受众夹带部门',
      { audienceDepartmentIds: ['department-001'] },
      'KNOWLEDGE_AUDIENCE_INVALID',
    ],
    [
      '受众标识重复',
      {
        audienceMode: 'employment_scope',
        audienceDepartmentIds: ['department-001', 'department-001'],
      },
      'KNOWLEDGE_AUDIENCE_INVALID',
    ],
    [
      '受众标识超限',
      {
        audienceMode: 'employment_scope',
        audienceDepartmentIds: Array.from(
          { length: 201 },
          (_, index) => `department-${index}`,
        ),
      },
      'KNOWLEDGE_AUDIENCE_INVALID',
    ],
  ] as const)('课程不变量失败关闭：%s', (_label, override, code) => {
    expectDomainError(() => draftCourse(override), code);
  });

  it('发布、分配、进度与时间事实在非法状态下失败关闭', () => {
    const draft = draftCourse();
    expectDomainError(() => publishCourseVersion(draft, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      contentVerified: false,
      questionBankVerified: true,
    }, NOW), 'KNOWLEDGE_COURSE_PUBLISH_INVALID');
    expectDomainError(() => publishCourseVersion(draft, {
      tenantId: 'tenant-other',
      expectedVersion: 1,
      contentVerified: true,
      questionBankVerified: true,
    }, NOW), 'KNOWLEDGE_CROSS_TENANT');
    expectDomainError(() => publishCourseVersion(draft, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      contentVerified: true,
      questionBankVerified: true,
    }, NOW), 'KNOWLEDGE_VERSION_CONFLICT');
    expectDomainError(
      () => assignment({ coursePublished: false }),
      'KNOWLEDGE_COURSE_NOT_PUBLISHED',
    );
    expectDomainError(
      () => assignment({ dueDate: '2026/08/31' }),
      'KNOWLEDGE_DATE_INVALID',
    );
    expectDomainError(
      () => assignment({ dueDate: '2026-02-30' }),
      'KNOWLEDGE_DATE_INVALID',
    );
    expectDomainError(
      () => createTrainingAssignment(ASSIGNMENT_INPUT, new Date('invalid')),
      'KNOWLEDGE_TIME_INVALID',
    );

    const active = assignment();
    const zero = recordTrainingProgress(active, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      progressBps: 0,
    }, NOW);
    expect(zero.status).toBe('assigned');
    expectDomainError(() => recordTrainingProgress(active, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      progressBps: Number.NaN,
    }, NOW), 'KNOWLEDGE_BPS_INVALID');
    expectDomainError(() => recordTrainingProgress(
      { ...active, status: 'expired' },
      { tenantId: 'tenant-001', expectedVersion: 1, progressBps: 1 },
      NOW,
    ), 'KNOWLEDGE_ASSIGNMENT_TERMINAL');
  });

  it('考试尝试在领域层强制人工复核证据与评分事实', () => {
    expectDomainError(() => createExamAttempt({
      ...ATTEMPT_INPUT,
      attemptNumber: 0,
    }, NOW), 'KNOWLEDGE_ATTEMPT_NUMBER_INVALID');
    expectDomainError(() => createExamAttempt({
      ...ATTEMPT_INPUT,
      questionSetDigest: 'invalid',
    }, NOW), 'KNOWLEDGE_QUESTION_DIGEST_INVALID');
    expectDomainError(() => createExamAttempt({
      ...ATTEMPT_INPUT,
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-manual-v2',
      passingRule: 'all_required_sections',
      passedOverride: true,
    }, NOW), 'KNOWLEDGE_MANUAL_REVIEW_EVIDENCE_REQUIRED');
    expectDomainError(() => createExamAttempt({
      ...ATTEMPT_INPUT,
      questionMode: 'subjective',
      gradingPolicyVersion: 'manual-v2',
      passingRule: 'all_required_sections',
      manualReviewEvidenceId: '',
      passedOverride: true,
    }, NOW), 'KNOWLEDGE_ID_INVALID');

    const reviewed = createExamAttempt({
      ...ATTEMPT_INPUT,
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-manual-v2',
      passingRule: 'all_required_sections',
      manualReviewEvidenceId: 'review-001',
      submissionReason: 'timeout',
      passedOverride: true,
    }, NOW);
    expect(reviewed).toMatchObject({
      manualReviewEvidenceId: 'review-001',
      submissionReason: 'timeout',
      passed: true,
    });
  });

  it('完成任务拒绝内容不完整、伪造考试证据，并支持免试完成', () => {
    const active = assignment();
    expectDomainError(() => completeTrainingAssignment(active, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      completionEvidenceId: 'completion-001',
      passedExamAttemptId: 'attempt-001',
      examPassedVerified: true,
    }, NOW), 'KNOWLEDGE_CONTENT_INCOMPLETE');

    const completeContent = { ...active, progressBps: 10_000 };
    expectDomainError(() => completeTrainingAssignment(completeContent, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      completionEvidenceId: 'completion-001',
      passedExamAttemptId: 'attempt-001',
      examPassedVerified: false,
    }, NOW), 'KNOWLEDGE_PASSED_EXAM_REQUIRED');

    const noExam = { ...completeContent, examRequired: false };
    expectDomainError(() => completeTrainingAssignment(noExam, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      completionEvidenceId: 'completion-001',
      passedExamAttemptId: 'attempt-001',
      examPassedVerified: true,
    }, NOW), 'KNOWLEDGE_EXAM_EVIDENCE_UNEXPECTED');
    expect(completeTrainingAssignment(noExam, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      completionEvidenceId: 'completion-001',
      examPassedVerified: false,
    }, NOW)).toMatchObject({
      status: 'completed',
      passedExamAttemptId: null,
      completionEvidenceId: 'completion-001',
    });
  });
});
