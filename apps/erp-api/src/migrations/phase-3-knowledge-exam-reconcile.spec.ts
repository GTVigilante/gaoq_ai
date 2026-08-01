import { describe, expect, it } from 'vitest';

import {
  buildInconsistentGradedRunsPipeline,
  buildOrphanedExamAttemptsPipeline,
  buildRecentMissingTerminalEventsPipeline,
} from './phase-3-knowledge-exam-reconcile.js';

describe('Knowledge 考试运行只读对账', () => {
  it('最终评分按租户、运行引用、任务、次数、提交与题集摘要逐字段核对', () => {
    const serialized = JSON.stringify(buildInconsistentGradedRunsPipeline());
    for (const field of [
      'tenantId',
      'finalAttemptId',
      'assignmentId',
      'attemptNumber',
      'submissionRef',
      'questionSetDigest',
    ]) expect(serialized).toContain(field);
    expect(serialized).toContain('knowledge_exam_attempts');
  });

  it('反向识别无唯一评分运行的孤立最终尝试', () => {
    const serialized = JSON.stringify(buildOrphanedExamAttemptsPipeline());
    expect(serialized).toContain('knowledge_exam_runs');
    expect(serialized).toContain('gradedRuns');
    expect(serialized).toContain('finalAttemptId');
  });

  it('只在 Outbox TTL 安全窗口核对评分与死信终态事件', () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const serialized = JSON.stringify(buildRecentMissingTerminalEventsPipeline(now));
    expect(serialized).toContain('integration_outbox');
    expect(serialized).toContain('knowledge.exam.graded');
    expect(serialized).toContain('knowledge.exam.run.dead');
    expect(serialized).toContain('2026-06-28T00:00:00.000Z');
  });
});
