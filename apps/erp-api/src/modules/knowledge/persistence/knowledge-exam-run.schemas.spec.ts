import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  KnowledgeExamRunRecordSchema,
} from './knowledge-exam-run.schemas.js';
import type { KnowledgeExamRunRecord } from './knowledge-exam-run.schemas.js';

const mongoose = new Mongoose();
const RunModel = mongoose.model<KnowledgeExamRunRecord>(
  'SpecKnowledgeExamRun',
  KnowledgeExamRunRecordSchema,
);

describe('Knowledge 考试运行持久化契约', () => {
  it('接受完整启动事实并拒绝在运行记录保存答案字段', async () => {
    await expect(new RunModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      courseVersionId: 'course-001',
      questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43),
      attemptNumber: 1,
      questionMode: 'objective',
      gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold',
      passingScoreBps: 8_000,
      maxAttempts: 3,
      timeLimitMinutes: 60,
      manualReviewRequired: false,
      gradingSlaMinutes: 5,
      manualReviewSlaMinutes: 1_440,
      status: 'starting',
      attempts: 0,
      reviewPolls: 0,
      nextActionAt: new Date('2026-07-27T00:00:00.000Z'),
      version: 1,
    }).validate()).resolves.toBeUndefined();
    expect(Object.keys(KnowledgeExamRunRecordSchema.paths)).not.toEqual(
      expect.arrayContaining(['answers', 'questions', 'correctAnswers', 'accessToken']),
    );
  });

  it('拒绝伪造摘要、缺失人工复核证据和错位超时提交时间', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      courseVersionId: 'course-001',
      questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43),
      attemptNumber: 1,
      questionMode: 'subjective' as const,
      gradingPolicyVersion: 'manual-v1',
      passingRule: 'all_required_sections' as const,
      passingScoreBps: 8_000,
      maxAttempts: 3,
      timeLimitMinutes: 60,
      manualReviewRequired: true,
      gradingSlaMinutes: 5,
      manualReviewSlaMinutes: 1_440,
      gatewaySessionRef: 'session-001',
      questionSetDigest: 'b'.repeat(43),
      startedAt: new Date('2026-07-27T00:00:00.000Z'),
      deadlineAt: new Date('2026-07-27T01:00:00.000Z'),
      submissionRef: 'submission-001',
      submittedAt: new Date('2026-07-27T01:00:00.000Z'),
      submissionReason: 'timeout' as const,
      timedOut: true,
      attempts: 0,
      reviewPolls: 1,
      nextActionAt: new Date('2026-07-27T01:01:00.000Z'),
      version: 4,
    };
    await expect(new RunModel({
      ...base,
      questionBankDigest: '*'.repeat(43),
      status: 'pending_review',
      reviewEvidenceId: 'review-001',
    }).validate()).rejects.toThrow();
    await expect(new RunModel({
      ...base,
      status: 'graded',
      reviewEvidenceId: null,
      finalAttemptId: 'attempt-001',
    }).validate()).rejects.toThrow('Knowledge 考试终态缺少最终尝试');
    await expect(new RunModel({
      ...base,
      status: 'pending_review',
      reviewEvidenceId: 'review-001',
      submittedAt: new Date('2026-07-27T00:59:59.000Z'),
    }).validate()).rejects.toThrow('Knowledge 考试超时提交时间非法');
  });
});
