import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  inferReplayStatus,
  knowledgeExamReplayErrorCode,
  parseKnowledgeExamReplayCommand,
  replayKnowledgeExamRun,
  runKnowledgeExamReplayCli,
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

  it.each([
    ['非法任务标识', { assignmentId: 'bad id' }],
    ['非法课程版本标识', { courseVersionId: '' }],
    ['非法考试次数', { attemptNumber: 0 }],
    ['考试次数超过策略', { attemptNumber: 4 }],
    ['非法题型', { questionMode: 'essay' }],
    ['人工复核策略错位', { manualReviewRequired: true }],
    ['非法超时事实', { timedOut: 'true' }],
    ['非法网关引用类型', { gatewaySessionRef: 1 }],
    ['缺少网关会话的提交', { gatewaySessionRef: null }],
    ['缺少题集摘要', { questionSetDigest: null }],
    ['非法题集摘要', { questionSetDigest: 'bad-digest' }],
    ['缺少开始时间', { startedAt: null }],
    ['非法时间类型', { deadlineAt: '2026-07-27T00:30:00.000Z' }],
    ['截止时间不晚于开始时间', {
      deadlineAt: new Date('2026-07-27T00:00:00.000Z'),
    }],
    ['缺少提交时间', { submittedAt: null }],
    ['缺少提交原因', { submissionReason: null }],
    ['超时标记与原因错位', { submissionReason: 'timeout' }],
    ['超时提交时间与截止时间错位', {
      submissionReason: 'timeout',
      timedOut: true,
    }],
    ['客观题绑定人工复核', { reviewEvidenceId: 'review-001' }],
    ['dead 记录绑定最终尝试', { finalAttemptId: 'attempt-001' }],
    ['缺少提交的人工复核', { submissionRef: null, reviewEvidenceId: 'review-001' }],
    ['缺少提交的超时事实', {
      gatewaySessionRef: 'session-001',
      submissionRef: null,
      timedOut: true,
    }],
  ])('拒绝受损 dead 记录：%s', async (_label, override) => {
    const fixture = connectionFixture({ ...examRunRecord, ...override });
    await expect(replayKnowledgeExamRun(
      fixture.connection,
      replayInput,
      'dry-run',
    )).rejects.toThrow('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
    expect(fixture.updateOne).not.toHaveBeenCalled();
    expect(fixture.insertOne).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledOnce();
  });
});

describe('Knowledge 考试运行重放 CLI', () => {
  it('解析唯一模式、精确参数和十进制正整数版本', () => {
    expect(parseKnowledgeExamReplayCommand(
      ['--', '--dry-run', ...replayArguments],
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
    )).toEqual({
      uri: 'mongodb://database.example.invalid/erp',
      mode: 'dry-run',
      input: replayInput,
    });
    expect(parseKnowledgeExamReplayCommand(
      ['--apply', ...replayArguments],
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
    ).mode).toBe('apply');
  });

  it.each([
    ['缺少模式', replayArguments],
    ['模式重复', ['--dry-run', '--apply', ...replayArguments]],
    ['参数缺值', ['--dry-run', '--tenant-id']],
    ['未知参数', ['--dry-run', ...replayArguments, '--extra', 'value']],
    ['参数重复', ['--dry-run', ...replayArguments, '--tenant-id', 'tenant-002']],
    ['零版本', ['--dry-run', ...replaceArgument('--expected-version', '0')]],
    ['指数版本', ['--dry-run', ...replaceArgument('--expected-version', '1e3')]],
    ['超大版本', [
      '--dry-run',
      ...replaceArgument('--expected-version', '9999999999999999'),
    ]],
  ])('拒绝不确定 CLI 输入：%s', (_label, args) => {
    expect(() => parseKnowledgeExamReplayCommand(
      args,
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
    )).toThrow('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
  });

  it.each([
    ['缺少 URI', {}],
    ['非 MongoDB URI', { MONGODB_URI: 'https://database.example.invalid' }],
  ])('拒绝无效数据库配置：%s', (_label, environment) => {
    expect(() => parseKnowledgeExamReplayCommand(
      ['--dry-run', ...replayArguments],
      environment,
    )).toThrow('KNOWLEDGE_EXAM_REPLAY_MONGODB_URI_REQUIRED');
  });

  it('连接后执行重放、输出单行 JSON 并始终关闭连接', async () => {
    const fixture = connectionFixture();
    const connect = vi.fn().mockReturnValue(fixture.connection);
    const writeOutput = vi.fn();
    await runKnowledgeExamReplayCli(
      ['--apply', ...replayArguments],
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
      { connect, writeOutput },
    );
    expect(connect).toHaveBeenCalledWith('mongodb://database.example.invalid/erp');
    expect(fixture.asPromise).toHaveBeenCalledOnce();
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(JSON.parse(String(writeOutput.mock.calls[0]?.[0]))).toMatchObject({
      tenantId: replayInput.tenantId,
      runId: replayInput.runId,
      version: 5,
      applied: true,
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('业务失败或连接失败仍关闭连接且不输出结果', async () => {
    const stateConflict = connectionFixture(null);
    const writeOutput = vi.fn();
    await expect(runKnowledgeExamReplayCli(
      ['--apply', ...replayArguments],
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
      { connect: () => stateConflict.connection, writeOutput },
    )).rejects.toThrow('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
    expect(stateConflict.close).toHaveBeenCalledOnce();
    expect(writeOutput).not.toHaveBeenCalled();

    const connectionFailure = connectionFixture();
    connectionFailure.asPromise.mockRejectedValueOnce(new Error('secret connection detail'));
    await expect(runKnowledgeExamReplayCli(
      ['--dry-run', ...replayArguments],
      { MONGODB_URI: 'mongodb://database.example.invalid/erp' },
      { connect: () => connectionFailure.connection, writeOutput },
    )).rejects.toThrow('secret connection detail');
    expect(connectionFailure.close).toHaveBeenCalledOnce();
    expect(writeOutput).not.toHaveBeenCalled();
  });

  it('只向终端暴露稳定错误码', () => {
    expect(knowledgeExamReplayErrorCode(
      new Error('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT'),
    )).toBe('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
    expect(knowledgeExamReplayErrorCode(new Error('password=secret'))).toBe(
      'KNOWLEDGE_EXAM_REPLAY_DATABASE_FAILURE',
    );
    expect(knowledgeExamReplayErrorCode('unknown')).toBe(
      'KNOWLEDGE_EXAM_REPLAY_DATABASE_FAILURE',
    );
  });
});

const replayInput = {
  tenantId: 'tenant-001',
  runId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
  expectedVersion: 4,
  reasonCode: 'GATEWAY_RECOVERED',
} as const;

const replayArguments = [
  '--tenant-id',
  replayInput.tenantId,
  '--run-id',
  replayInput.runId,
  '--expected-version',
  String(replayInput.expectedVersion),
  '--reason-code',
  replayInput.reasonCode,
] as const;

const examRunRecord = {
  tenantId: 'tenant-001',
  id: replayInput.runId,
  status: 'dead',
  version: 4,
  assignmentId: 'assignment-001',
  courseVersionId: 'course-001',
  attemptNumber: 1,
  maxAttempts: 3,
  questionMode: 'objective',
  manualReviewRequired: false,
  gatewaySessionRef: 'session-001',
  submissionRef: 'submission-001',
  questionSetDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  reviewEvidenceId: null,
  finalAttemptId: null,
  startedAt: new Date('2026-07-27T00:00:00.000Z'),
  deadlineAt: new Date('2026-07-27T00:30:00.000Z'),
  submittedAt: new Date('2026-07-27T00:20:00.000Z'),
  submissionReason: 'learner',
  timedOut: false,
} as const;

function replaceArgument(key: string, value: string): readonly string[] {
  return replayArguments.map((argument, index) =>
    replayArguments[index - 1] === key ? value : argument,
  );
}

function connectionFixture(record: Record<string, unknown> | null = examRunRecord) {
  const findOne = vi.fn().mockResolvedValue(record);
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const asPromise = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    asPromise,
    close,
    startSession: vi.fn().mockResolvedValue(session),
    collection: vi.fn((name: string) => name === 'knowledge_exam_runs'
      ? { findOne, updateOne }
      : { insertOne }),
  } as unknown as Connection;
  return { connection, findOne, updateOne, insertOne, asPromise, close, session };
}
