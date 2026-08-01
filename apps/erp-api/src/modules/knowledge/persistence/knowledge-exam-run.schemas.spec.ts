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

const startingRun = {
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
  gatewaySessionRef: null,
  submissionRef: null,
  questionSetDigest: null,
  reviewEvidenceId: null,
  finalAttemptId: null,
  startedAt: null,
  deadlineAt: null,
  submittedAt: null,
  submissionReason: null,
  timedOut: false,
  attempts: 0,
  reviewPolls: 0,
  nextActionAt: new Date('2026-07-27T00:00:00.000Z'),
  lastErrorCode: null,
  lockedAt: null,
  lockedBy: null,
  replayReason: null,
  replayedAt: null,
  version: 1,
} as const;

const inProgressRun = {
  ...startingRun,
  status: 'in_progress',
  gatewaySessionRef: 'session-001',
  questionSetDigest: 'b'.repeat(43),
  startedAt: new Date('2026-07-27T00:00:00.000Z'),
  deadlineAt: new Date('2026-07-27T01:00:00.000Z'),
} as const;

const submittedRun = {
  ...inProgressRun,
  status: 'submitted',
  submissionRef: 'submission-001',
  submittedAt: new Date('2026-07-27T00:30:00.000Z'),
  submissionReason: 'learner',
} as const;

describe('Knowledge 考试运行持久化契约', () => {
  it('接受完整启动事实并拒绝在运行记录保存答案字段', async () => {
    await expect(new RunModel(startingRun).validate()).resolves.toBeUndefined();
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

  it('考试次数、题型和人工复核策略必须一致', async () => {
    await expect(new RunModel({
      ...startingRun,
      attemptNumber: 4,
    }).validate()).rejects.toThrow('Knowledge 考试运行策略组合非法');
    await expect(new RunModel({
      ...startingRun,
      manualReviewRequired: true,
    }).validate()).rejects.toThrow('Knowledge 考试运行策略组合非法');
    await expect(new RunModel({
      ...startingRun,
      questionMode: 'subjective',
      manualReviewRequired: true,
    }).validate()).resolves.toBeUndefined();
  });

  it('starting 禁止提前持有任何运行、提交、复核或终态事实', async () => {
    const facts = {
      gatewaySessionRef: 'session-001',
      questionSetDigest: 'b'.repeat(43),
      startedAt: new Date('2026-07-27T00:00:00.000Z'),
      deadlineAt: new Date('2026-07-27T01:00:00.000Z'),
      submissionRef: 'submission-001',
      submittedAt: new Date('2026-07-27T00:30:00.000Z'),
      submissionReason: 'learner',
      reviewEvidenceId: 'review-001',
      finalAttemptId: 'attempt-001',
      timedOut: true,
    } as const;
    for (const [field, value] of Object.entries(facts)) {
      await expect(new RunModel({
        ...startingRun,
        [field]: value,
      }).validate()).rejects.toThrow('Knowledge 考试启动状态非法');
    }
  });

  it('运行中状态必须持有完整启动事实且不得提前持有提交事实', async () => {
    await expect(new RunModel(inProgressRun).validate()).resolves.toBeUndefined();
    for (const field of [
      'gatewaySessionRef',
      'questionSetDigest',
      'startedAt',
      'deadlineAt',
    ] as const) {
      await expect(new RunModel({
        ...inProgressRun,
        [field]: null,
      }).validate()).rejects.toThrow('Knowledge 考试运行证据不完整');
    }
    for (const [field, value] of [
      ['submissionRef', 'submission-001'],
      ['submittedAt', new Date('2026-07-27T00:30:00.000Z')],
      ['submissionReason', 'learner'],
      ['reviewEvidenceId', 'review-001'],
      ['finalAttemptId', 'attempt-001'],
    ] as const) {
      await expect(new RunModel({
        ...inProgressRun,
        [field]: value,
      }).validate()).rejects.toThrow(/超时证据组合非法|非评分终态/);
    }
  });

  it('已提交状态必须持有完整提交事实且不得提前持有复核或终态事实', async () => {
    await expect(new RunModel(submittedRun).validate()).resolves.toBeUndefined();
    for (const field of ['submissionRef', 'submittedAt', 'submissionReason'] as const) {
      await expect(new RunModel({
        ...submittedRun,
        [field]: null,
      }).validate()).rejects.toThrow('Knowledge 考试提交证据不完整');
    }
    await expect(new RunModel({
      ...submittedRun,
      reviewEvidenceId: 'review-001',
    }).validate()).rejects.toThrow('Knowledge 考试已提交状态非法');
    await expect(new RunModel({
      ...submittedRun,
      finalAttemptId: 'attempt-001',
    }).validate()).rejects.toThrow('Knowledge 考试已提交状态非法');
  });

  it('超时事实与截止时间必须精确对应', async () => {
    await expect(new RunModel({
      ...submittedRun,
      submissionReason: 'timeout',
      submittedAt: submittedRun.deadlineAt,
      timedOut: true,
    }).validate()).resolves.toBeUndefined();
    await expect(new RunModel({
      ...submittedRun,
      timedOut: true,
    }).validate()).rejects.toThrow('Knowledge 考试超时证据组合非法');
    await expect(new RunModel({
      ...submittedRun,
      submissionReason: 'timeout',
    }).validate()).rejects.toThrow('Knowledge 考试超时证据组合非法');
    await expect(new RunModel({
      ...inProgressRun,
      deadlineAt: inProgressRun.startedAt,
    }).validate()).rejects.toThrow('Knowledge 考试时限组合非法');
    await expect(new RunModel({
      ...submittedRun,
      submissionReason: 'timeout',
      timedOut: true,
    }).validate()).rejects.toThrow('Knowledge 考试超时提交时间非法');
  });

  it('人工复核与评分终态必须绑定对应证据', async () => {
    await expect(new RunModel({
      ...submittedRun,
      status: 'pending_review',
      reviewEvidenceId: 'review-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new RunModel({
      ...submittedRun,
      status: 'pending_review',
    }).validate()).rejects.toThrow('Knowledge 考试人工复核状态非法');
    await expect(new RunModel({
      ...submittedRun,
      status: 'pending_review',
      reviewEvidenceId: 'review-001',
      finalAttemptId: 'attempt-001',
    }).validate()).rejects.toThrow('Knowledge 考试人工复核状态非法');
    await expect(new RunModel({
      ...submittedRun,
      status: 'graded',
      finalAttemptId: 'attempt-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new RunModel({
      ...submittedRun,
      status: 'graded',
    }).validate()).rejects.toThrow('Knowledge 考试终态缺少最终尝试');
    await expect(new RunModel({
      ...submittedRun,
      status: 'graded',
      questionMode: 'mixed',
      manualReviewRequired: true,
      finalAttemptId: 'attempt-001',
    }).validate()).rejects.toThrow('Knowledge 考试终态缺少最终尝试');
    await expect(new RunModel({
      ...submittedRun,
      status: 'graded',
      questionMode: 'mixed',
      manualReviewRequired: true,
      reviewEvidenceId: 'review-001',
      finalAttemptId: 'attempt-001',
    }).validate()).resolves.toBeUndefined();
  });

  it('非评分终态不能绑定最终尝试，运行锁必须成对出现', async () => {
    await expect(new RunModel({
      ...inProgressRun,
      status: 'dead',
      finalAttemptId: 'attempt-001',
    }).validate()).rejects.toThrow('Knowledge 考试非评分终态不能绑定最终尝试');
    await expect(new RunModel({
      ...inProgressRun,
      lockedAt: new Date('2026-07-27T00:00:01.000Z'),
      lockedBy: 'worker-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new RunModel({
      ...inProgressRun,
      lockedAt: new Date('2026-07-27T00:00:01.000Z'),
    }).validate()).rejects.toThrow('Knowledge 考试运行锁组合非法');
    await expect(new RunModel({
      ...inProgressRun,
      lockedBy: 'worker-001',
    }).validate()).rejects.toThrow('Knowledge 考试运行锁组合非法');
  });

  it('重放原因和时间必须成对出现且原因只接受受控编码', async () => {
    await expect(new RunModel({
      ...startingRun,
      replayReason: 'GATEWAY_RECOVERED',
      replayedAt: new Date('2026-07-27T00:00:01.000Z'),
    }).validate()).resolves.toBeUndefined();
    await expect(new RunModel({
      ...startingRun,
      replayReason: 'GATEWAY_RECOVERED',
    }).validate()).rejects.toThrow('Knowledge 考试重放证据组合非法');
    await expect(new RunModel({
      ...startingRun,
      replayedAt: new Date('2026-07-27T00:00:01.000Z'),
    }).validate()).rejects.toThrow('Knowledge 考试重放证据组合非法');
    await expect(new RunModel({
      ...startingRun,
      replayReason: '用户确认可以重试',
      replayedAt: new Date('2026-07-27T00:00:01.000Z'),
    }).validate()).rejects.toThrow();
  });
});
