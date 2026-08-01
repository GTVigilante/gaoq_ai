import { describe, expect, it } from 'vitest';

import { createKnowledgeExamRun } from './exam-run.js';

const NOW = new Date('2026-07-27T00:00:00.000Z');
const INPUT = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
  tenantId: 'tenant-001',
  assignmentId: 'assignment-001',
  courseVersionId: 'course-001',
  questionBankRef: 'bank-001',
  questionBankDigest: 'a'.repeat(43),
  attemptNumber: 1,
  questionMode: 'mixed' as const,
  gradingPolicyVersion: 'mixed-v2',
  passingRule: 'all_required_sections' as const,
  passingScoreBps: 8_000,
  maxAttempts: 2,
  timeLimitMinutes: 90,
  manualReviewRequired: true,
  gradingSlaMinutes: 5,
  manualReviewSlaMinutes: 1_440,
};

describe('Knowledge 考试运行领域', () => {
  it('创建时锁定课程策略且不保存题目、答案或访问令牌', () => {
    const run = createKnowledgeExamRun(INPUT, NOW);
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
      ...INPUT,
      questionMode: 'subjective',
      manualReviewRequired: false,
    }, NOW)).toThrow('KNOWLEDGE_EXAM_REVIEW_POLICY_INVALID');
    expect(() => createKnowledgeExamRun({
      ...INPUT,
      questionMode: 'objective',
      manualReviewRequired: true,
    }, NOW)).toThrow('KNOWLEDGE_EXAM_REVIEW_POLICY_INVALID');
  });

  it.each([
    ['考试次数非整数', { attemptNumber: Number.NaN }],
    ['考试次数超过上限', { attemptNumber: 3 }],
    ['及格分低于下限', { passingScoreBps: -1 }],
    ['及格分超过上限', { passingScoreBps: 10_001 }],
    ['最大考试次数低于下限', { maxAttempts: 0 }],
    ['最大考试次数超过上限', { maxAttempts: 11 }],
    ['答题时限低于下限', { timeLimitMinutes: 4 }],
    ['答题时限超过上限', { timeLimitMinutes: 241 }],
    ['自动评分 SLA 低于下限', { gradingSlaMinutes: 0 }],
    ['自动评分 SLA 超过上限', { gradingSlaMinutes: 61 }],
    ['人工复核 SLA 低于下限', { manualReviewSlaMinutes: 29 }],
    ['人工复核 SLA 超过上限', { manualReviewSlaMinutes: 10_081 }],
  ] as const)('拒绝非法考试策略：%s', (_label, override) => {
    expect(() => createKnowledgeExamRun({ ...INPUT, ...override }, NOW))
      .toThrow('KNOWLEDGE_EXAM_POLICY_INVALID');
  });
});
