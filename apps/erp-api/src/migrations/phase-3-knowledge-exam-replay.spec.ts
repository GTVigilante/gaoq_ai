import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  inferReplayStatus,
  replayKnowledgeExamRun,
} from './phase-3-knowledge-exam-replay.js';

describe('Knowledge 考试运行显式重放', () => {
  it('按已形成的最远证据恢复到唯一可继续状态', () => {
    expect(inferReplayStatus({
      gatewaySessionRef: null, submissionRef: null, reviewEvidenceId: null,
    })).toBe('starting');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: null, reviewEvidenceId: null,
    })).toBe('in_progress');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: 'submission-001',
      reviewEvidenceId: null,
    })).toBe('submitted');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: 'submission-001',
      reviewEvidenceId: 'review-001',
    })).toBe('pending_review');
  });

  it('dry-run 只校验 dead 状态和版本，不写运行记录或 Outbox', async () => {
    const fixture = connectionFixture();
    const result = await replayKnowledgeExamRun(fixture.connection, replayInput, 'dry-run');
    expect(result).toMatchObject({
      previousVersion: 4,
      version: 5,
      status: 'submitted',
      applied: false,
    });
    expect(fixture.updateOne).not.toHaveBeenCalled();
    expect(fixture.insertOne).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledOnce();
  });

  it('apply 同事务写入受控重放事实并追加脱敏 replayed 事件', async () => {
    const fixture = connectionFixture();
    const result = await replayKnowledgeExamRun(fixture.connection, replayInput, 'apply');
    expect(result.applied).toBe(true);
    const update = fixture.updateOne.mock.calls[0]?.[1] as {
      readonly $set?: Record<string, unknown>;
      readonly $inc?: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'submitted',
      attempts: 0,
      lastErrorCode: null,
      replayReason: 'GATEWAY_RECOVERED',
    });
    expect(update.$set?.replayedAt).toBeInstanceOf(Date);
    expect(update.$set?.replayedAt).toEqual(update.$set?.updatedAt);
    expect(update.$inc).toEqual({ version: 1 });
    const inserted = JSON.stringify(fixture.insertOne.mock.calls);
    expect(inserted).toContain('cn.gaoq.erp.knowledge.exam.run.replayed.v1');
    expect(inserted).toContain('"aggregateVersion":5');
    expect(inserted).toContain('"reasonCode":"GATEWAY_RECOVERED"');
    expect(inserted).not.toMatch(/answer|correctAnswer|accessToken/iu);
  });

  it('拒绝自由文本、非 dead 状态和更新竞争丢失', async () => {
    const fixture = connectionFixture();
    await expect(replayKnowledgeExamRun(fixture.connection, {
      ...replayInput,
      reasonCode: '人工确认可以重试',
    }, 'dry-run')).rejects.toThrow('KNOWLEDGE_EXAM_REPLAY_INPUT_INVALID');
    fixture.findOne.mockResolvedValueOnce(null);
    await expect(replayKnowledgeExamRun(
      fixture.connection,
      replayInput,
      'apply',
    )).rejects.toThrow('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
    fixture.findOne.mockResolvedValueOnce(examRunRecord);
    fixture.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(replayKnowledgeExamRun(
      fixture.connection,
      replayInput,
      'apply',
    )).rejects.toThrow('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
  });
});

const replayInput = {
  tenantId: 'tenant-001',
  runId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
  expectedVersion: 4,
  reasonCode: 'GATEWAY_RECOVERED',
} as const;

const examRunRecord = {
  tenantId: 'tenant-001',
  id: replayInput.runId,
  status: 'dead',
  version: 4,
  assignmentId: 'assignment-001',
  courseVersionId: 'course-001',
  attemptNumber: 1,
  questionMode: 'objective',
  gatewaySessionRef: 'session-001',
  submissionRef: 'submission-001',
  reviewEvidenceId: null,
  timedOut: false,
} as const;

function connectionFixture() {
  const findOne = vi.fn().mockResolvedValue(examRunRecord);
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
    collection: vi.fn((name: string) => name === 'knowledge_exam_runs'
      ? { findOne, updateOne }
      : { insertOne }),
  } as unknown as Connection;
  return { connection, findOne, updateOne, insertOne, session };
}
