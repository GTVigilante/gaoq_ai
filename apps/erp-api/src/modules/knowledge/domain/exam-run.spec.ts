import { describe, expect, it } from 'vitest';

import { createKnowledgeExamRun } from './exam-run.js';

const NOW = new Date('2026-07-27T00:00:00.000Z');

describe('Knowledge 考试运行领域', () => {
  it('创建时锁定课程策略且不保存题目、答案或访问令牌', () => {
    const run = createKnowledgeExamRun({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      courseVersionId: 'course-001',
      questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43),
      attemptNumber: 1,
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-v2',
      passingRule: 'all_required_sections',
      passingScoreBps: 8_000,
      maxAttempts: 2,
      timeLimitMinutes: 90,
      manualReviewRequired: true,
      gradingSlaMinutes: 5,
      manualReviewSlaMinutes: 1_440,
    }, NOW);
    expect(run).toMatchObject({
      status: 'starting',
      passingRule: 'all_required_sections',
      manualReviewRequired: true,
      attempts: 0,
      reviewPolls: 0,
      version: 1,
    });
    expect(run).not.toHaveProperty('answers');
    expect(run).not.toHaveProperty('questions');
    expect(run).not.toHaveProperty('accessToken');
  });

  it('拒绝题型与人工复核策略不一致', () => {
    expect(() => createKnowledgeExamRun({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      courseVersionId: 'course-001',
      questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43),
      attemptNumber: 1,
      questionMode: 'subjective',
      gradingPolicyVersion: 'manual-v1',
      passingRule: 'score_threshold',
      passingScoreBps: 8_000,
      maxAttempts: 2,
      timeLimitMinutes: 60,
      manualReviewRequired: false,
      gradingSlaMinutes: 5,
      manualReviewSlaMinutes: 1_440,
    }, NOW)).toThrow('KNOWLEDGE_EXAM_REVIEW_POLICY_INVALID');
  });
});
