import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type {
  KnowledgeExamFinalizationReceipt,
  KnowledgeExamStartReceipt,
  KnowledgeExamTimeoutReceipt,
} from './application/knowledge-ports.js';
import {
  GradingCircuitBreaker,
  KnowledgeExamRunRelayService,
} from './knowledge-exam-run-relay.service.js';

const START_RECEIPT: KnowledgeExamStartReceipt = {
  gatewaySessionRef: 'gateway-session-001',
  questionSetDigest: 'q'.repeat(43),
  startedAt: '2026-07-27T01:00:00.000Z',
  deadlineAt: '2026-07-27T02:00:00.000Z',
};
const TIMEOUT_RECEIPT: KnowledgeExamTimeoutReceipt = {
  submissionRef: 'submission-001',
  submittedAt: '2026-07-27T02:00:01.000Z',
};
const GRADED_RECEIPT: KnowledgeExamFinalizationReceipt = {
  status: 'graded',
  scoreBps: 8_500,
  passed: true,
  gradingEvidenceId: 'grading-evidence-001',
  gradedAt: '2026-07-27T02:05:00.000Z',
};
const PENDING_RECEIPT: KnowledgeExamFinalizationReceipt = {
  status: 'pending_review',
  reviewEvidenceId: 'review-evidence-001',
  reviewRequestedAt: '2026-07-27T02:03:00.000Z',
};

type RunStatus = 'starting' | 'in_progress' | 'submitted' | 'pending_review';

function runRecord(
  status: RunStatus,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const started = status !== 'starting';
  const submitted = status === 'submitted' || status === 'pending_review';
  return {
    id: 'exam-run-001',
    tenantId: 'tenant-001',
    assignmentId: 'assignment-001',
    courseVersionId: 'course-version-001',
    attemptNumber: 1,
    questionBankRef: 'question-bank-001',
    questionBankDigest: 'b'.repeat(43),
    questionMode: 'objective' as const,
    gradingPolicyVersion: 'grading-policy-v1',
    passingRule: 'score_threshold' as const,
    timeLimitMinutes: 60,
    manualReviewRequired: false,
    status,
    passingScoreBps: 8_000,
    gradingSlaMinutes: 10,
    manualReviewSlaMinutes: 60,
    gatewaySessionRef: started ? START_RECEIPT.gatewaySessionRef : null,
    submissionRef: submitted ? TIMEOUT_RECEIPT.submissionRef : null,
    questionSetDigest: started ? START_RECEIPT.questionSetDigest : null,
    reviewEvidenceId: status === 'pending_review' ? 'review-evidence-001' : null,
    startedAt: started ? new Date(START_RECEIPT.startedAt) : null,
    deadlineAt: started ? new Date(START_RECEIPT.deadlineAt) : null,
    submittedAt: submitted ? new Date(TIMEOUT_RECEIPT.submittedAt) : null,
    submissionReason: submitted ? 'learner' as const : null,
    reviewPolls: status === 'pending_review' ? 1 : 0,
    timedOut: false,
    attempts: 0,
    version: 1,
    nextActionAt: new Date('2026-07-27T00:00:00.000Z'),
    lockedAt: new Date('2026-07-27T00:00:00.000Z'),
    lockedBy: 'worker-001',
    lastErrorCode: null,
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Knowledge 考试运行 Relay', () => {
  it('没有到期任务时刷新各状态积压指标并返回零', async () => {
    const fixture = createFixture();
    fixture.runs.aggregate.mockReturnValue(mongoQuery([
      {
        _id: 'starting',
        count: 2,
        oldestCreatedAt: new Date('2026-07-27T00:00:00.000Z'),
      },
      {
        _id: 'dead',
        count: 1,
        oldestCreatedAt: new Date('2026-07-27T00:30:00.000Z'),
      },
    ]));
    await expect(fixture.service.relayBatch('worker-001')).resolves.toBe(0);
    expect(fixture.metrics.setKnowledgeExamRunBacklog).toHaveBeenCalledTimes(5);
    expect(fixture.metrics.setKnowledgeExamRunBacklog).toHaveBeenCalledWith(
      'starting',
      2,
      expect.any(Number),
    );
    expect(fixture.metrics.setKnowledgeExamRunBacklog).toHaveBeenCalledWith(
      'submitted',
      0,
      0,
    );
  });

  it('启动考试时只向隔离网关发送控制字段并原子记录事件', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('starting'),
      runRecord('in_progress', {
        gatewaySessionRef: START_RECEIPT.gatewaySessionRef,
        questionSetDigest: START_RECEIPT.questionSetDigest,
        startedAt: new Date(START_RECEIPT.startedAt),
        deadlineAt: new Date(START_RECEIPT.deadlineAt),
        version: 2,
      }),
    );
    fixture.gateway.start.mockResolvedValue(START_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.gateway.start).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'exam-run-001',
      tenantId: 'tenant-001',
      questionBankRef: 'question-bank-001',
      questionBankDigest: 'b'.repeat(43),
      passingScoreBps: 8_000,
    }));
    expect(JSON.stringify(fixture.gateway.start.mock.calls)).not.toMatch(
      /answer|答案|token|authorization/iu,
    );
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.run.started' }),
      fixture.session,
    );
    expect(fixture.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        action: 'knowledge.exam.run.in_progress',
        outcome: 'success',
      }),
    );
    expect(fixture.session.endSession).toHaveBeenCalled();
  });

  it('到达截止时间后由网关封存答卷并进入 submitted', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('in_progress'),
      runRecord('submitted', {
        submissionRef: TIMEOUT_RECEIPT.submissionRef,
        submittedAt: new Date(TIMEOUT_RECEIPT.submittedAt),
        submissionReason: 'timeout',
        timedOut: true,
        version: 2,
      }),
    );
    fixture.gateway.timeout.mockResolvedValue(TIMEOUT_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.gateway.timeout).toHaveBeenCalledWith(expect.objectContaining({
      gatewaySessionRef: START_RECEIPT.gatewaySessionRef,
      questionSetDigest: START_RECEIPT.questionSetDigest,
      deadlineAt: START_RECEIPT.deadlineAt,
    }));
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.run.timed_out' }),
      fixture.session,
    );
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'timeout',
      'success',
    );
  });

  it('自动评分通过后在同一事务创建尝试、更新运行并写 Outbox', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(fixture, runRecord('submitted'));
    fixture.gateway.finalize.mockResolvedValue(GRADED_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.gateway.finalize).toHaveBeenCalledWith(expect.objectContaining({
      submissionRef: TIMEOUT_RECEIPT.submissionRef,
      timedOut: false,
      submittedAt: TIMEOUT_RECEIPT.submittedAt,
    }));
    expect(fixture.attempts.create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001',
        assignmentId: 'assignment-001',
        scoreBps: 8_500,
        passed: true,
        gradingEvidenceId: 'grading-evidence-001',
        submissionReason: 'learner',
      }),
    ], { session: fixture.session });
    expect(updateOneFilter(fixture)).toMatchObject({
      tenantId: 'tenant-001',
      id: 'exam-run-001',
      version: 1,
      lockedBy: 'worker-001',
    });
    expect(updateOneFields(fixture)).toMatchObject({
      status: 'graded',
      submissionReason: 'learner',
      lockedBy: null,
    });
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.graded' }),
      fixture.session,
    );
    expect(fixture.metrics.observeKnowledgeExamGrading).toHaveBeenCalledWith(
      'automatic',
      299,
    );
  });

  it('评分网关要求人工复核时保存证明并安排下一次轮询', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('submitted'),
      runRecord('pending_review', {
        reviewEvidenceId: 'review-evidence-001',
        reviewPolls: 1,
        version: 2,
      }),
    );
    fixture.gateway.finalize.mockResolvedValue(PENDING_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.run.review_pending' }),
      fixture.session,
    );
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'review',
      'pending',
    );
  });

  it.each([
    ['低 SLA 下限', 1],
    ['高 SLA 上限', 10_000],
  ])('人工复核持续 pending 时按%s受控轮询且不重复发事件', async (
    _name,
    manualReviewSlaMinutes,
  ) => {
    const fixture = createFixture();
    const claimed = runRecord('pending_review', { manualReviewSlaMinutes });
    queueFindOneAndUpdate(
      fixture,
      claimed,
      runRecord('pending_review', {
        manualReviewSlaMinutes,
        reviewPolls: 2,
        version: 2,
      }),
    );
    fixture.gateway.status.mockResolvedValue(PENDING_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.gateway.status).toHaveBeenCalledWith(expect.objectContaining({
      reviewEvidenceId: 'review-evidence-001',
    }));
    expect(fixture.outbox.append).not.toHaveBeenCalled();
  });

  it('人工复核完成后绑定复核证明并记录人工评分时延', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(fixture, runRecord('pending_review', {
      questionMode: 'mixed',
      manualReviewRequired: true,
    }));
    fixture.gateway.status.mockResolvedValue(GRADED_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.attempts.create).toHaveBeenCalledWith([
      expect.objectContaining({
        manualReviewEvidenceId: 'review-evidence-001',
      }),
    ], { session: fixture.session });
    expect(fixture.metrics.observeKnowledgeExamGrading).toHaveBeenCalledWith(
      'manual',
      299,
    );
  });

  it('人工复核必需但缺少证明时失败关闭并释放锁', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('submitted', {
        questionMode: 'mixed',
        manualReviewRequired: true,
      }),
      runRecord('submitted', {
        questionMode: 'mixed',
        manualReviewRequired: true,
        attempts: 1,
        lastErrorCode: 'KNOWLEDGE_EXAM_MANUAL_REVIEW_EVIDENCE_MISSING',
      }),
    );
    fixture.gateway.finalize.mockResolvedValue(GRADED_RECEIPT);
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastFindUpdate(fixture)).toMatchObject({
      status: 'submitted',
      attempts: 1,
      lastErrorCode: 'KNOWLEDGE_EXAM_MANUAL_REVIEW_EVIDENCE_MISSING',
      lockedBy: null,
    });
  });

  it.each([
    ['会话引用', 'submitted', { gatewaySessionRef: null }, 'KNOWLEDGE_EXAM_SESSION_MISSING'],
    ['题集摘要', 'submitted', { questionSetDigest: null }, 'KNOWLEDGE_EXAM_DIGEST_MISSING'],
    ['截止时间', 'in_progress', { deadlineAt: null }, 'KNOWLEDGE_EXAM_DEADLINE_MISSING'],
    ['提交引用', 'submitted', { submissionRef: null }, 'KNOWLEDGE_EXAM_SUBMISSION_MISSING'],
    ['提交时间', 'submitted', { submittedAt: null }, 'KNOWLEDGE_EXAM_SUBMITTED_AT_MISSING'],
    [
      '复核证明',
      'pending_review',
      { reviewEvidenceId: null },
      'KNOWLEDGE_EXAM_REVIEW_EVIDENCE_MISSING',
    ],
  ] as const)('缺少%s时使用稳定失败码并受控重试', async (
    _name,
    status,
    overrides,
    expectedCode,
  ) => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord(status, overrides),
      runRecord(status, { ...overrides, attempts: 1, lastErrorCode: expectedCode }),
    );
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastFindUpdate(fixture)).toMatchObject({
      status,
      attempts: 1,
      lastErrorCode: expectedCode,
    });
  });

  it('瞬时网关异常使用安全失败码并指数退避', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('starting'),
      runRecord('starting', { attempts: 1, lastErrorCode: 'KNOWLEDGE_EXAM_RUN_FAILED' }),
    );
    fixture.gateway.start.mockRejectedValue(new Error('upstream timeout 502'));
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastFindUpdate(fixture)).toMatchObject({
      status: 'starting',
      attempts: 1,
      lastErrorCode: 'KNOWLEDGE_EXAM_RUN_FAILED',
      lockedBy: null,
    });
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'gateway',
      'retry',
    );
  });

  it('第八次失败进入 dead、写事件并在提交后审计', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('starting', { attempts: 7 }),
      runRecord('starting', {
        status: 'dead',
        attempts: 8,
        version: 2,
        lastErrorCode: 'KNOWLEDGE_GATEWAY_UNAVAILABLE',
      }),
    );
    fixture.gateway.start.mockRejectedValue(new Error('KNOWLEDGE_GATEWAY_UNAVAILABLE'));
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(outboxEvent(fixture)).toMatchObject({
      type: 'knowledge.exam.run.dead',
      payload: {
        status: 'dead',
        failureCode: 'KNOWLEDGE_GATEWAY_UNAVAILABLE',
      },
    });
    expect(fixture.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ action: 'knowledge.exam.run.dead' }),
    );
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'gateway',
      'dead',
    );
  });

  it('连续五次网关失败后第六项由熔断器延期且不调用网关', async () => {
    const fixture = createFixture();
    const values: unknown[] = [];
    for (let index = 0; index < 5; index += 1) {
      values.push(
        runRecord('starting', { id: `run-${index}` }),
        runRecord('starting', {
          id: `run-${index}`,
          attempts: 1,
          lastErrorCode: 'KNOWLEDGE_GATEWAY_UNAVAILABLE',
        }),
      );
    }
    values.push(runRecord('starting', { id: 'run-circuit-open' }));
    queueFindOneAndUpdate(fixture, ...values);
    fixture.gateway.start.mockRejectedValue(new Error('KNOWLEDGE_GATEWAY_UNAVAILABLE'));
    await expect(fixture.service.relayBatch('worker-001', 6)).resolves.toBe(0);
    expect(fixture.gateway.start).toHaveBeenCalledTimes(5);
    expect(updateOneFilter(fixture)).toMatchObject({
      id: 'run-circuit-open',
      lockedBy: 'worker-001',
    });
    expect(updateOneFields(fixture)).toMatchObject({ lockedBy: null });
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'gateway',
      'deferred',
    );
  });

  it('评分事务认领丢失时结束会话并把任务释放为可重试', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('submitted'),
      runRecord('submitted', {
        attempts: 1,
        lastErrorCode: 'KNOWLEDGE_EXAM_RUN_CLAIM_LOST',
      }),
    );
    fixture.gateway.finalize.mockResolvedValue(GRADED_RECEIPT);
    fixture.runs.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(fixture.session.endSession).toHaveBeenCalledTimes(2);
    expect(lastFindUpdate(fixture)).toMatchObject({
      attempts: 1,
      lastErrorCode: 'KNOWLEDGE_EXAM_RUN_CLAIM_LOST',
    });
  });

  it('提交后的审计故障只记录日志，不回写业务终态', async () => {
    const fixture = createFixture();
    queueFindOneAndUpdate(
      fixture,
      runRecord('starting'),
      runRecord('in_progress', { version: 2 }),
    );
    fixture.gateway.start.mockResolvedValue(START_RECEIPT);
    fixture.audit.recordSystem.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));
    await expect(fixture.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(fixture.runs.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.metrics.recordKnowledgeExamRun).toHaveBeenCalledWith(
      'start',
      'success',
    );
  });

  it('指标刷新失败不影响已完成任务数量', async () => {
    const fixture = createFixture();
    fixture.runs.aggregate.mockReturnValue(mongoQuery(
      Promise.reject(new Error('METRICS_QUERY_FAILED')),
      true,
    ));
    await expect(fixture.service.relayBatch('worker-001')).resolves.toBe(0);
  });

  it('拒绝非法 Worker 标识和批量上限', async () => {
    const fixture = createFixture();
    await expect(fixture.service.relayBatch('invalid worker')).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_WORKER_INVALID',
    );
    await expect(fixture.service.relayBatch('worker-001', 0)).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_LIMIT_INVALID',
    );
    await expect(fixture.service.relayBatch('worker-001', 201)).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_LIMIT_INVALID',
    );
  });
});

describe('Knowledge 评分网关熔断器', () => {
  it('连续五次失败后熔断，冷却后只允许半开探测', () => {
    const circuit = new GradingCircuitBreaker();
    for (let index = 0; index < 5; index += 1) circuit.onFailure(1_000);
    expect(() => circuit.beforeRequest(1_001)).toThrow(
      'KNOWLEDGE_GRADING_CIRCUIT_OPEN',
    );
    expect(() => circuit.beforeRequest(31_001)).not.toThrow();
    expect(() => circuit.beforeRequest(31_001)).toThrow(
      'KNOWLEDGE_GRADING_CIRCUIT_OPEN',
    );
    circuit.onSuccess();
    expect(() => circuit.beforeRequest(31_002)).not.toThrow();
  });

  it('未达到阈值的失败不会熔断且成功会清空失败计数', () => {
    const circuit = new GradingCircuitBreaker();
    circuit.onFailure(1_000);
    circuit.onFailure(1_000);
    expect(() => circuit.beforeRequest(1_001)).not.toThrow();
    circuit.onSuccess();
    for (let index = 0; index < 4; index += 1) circuit.onFailure(2_000);
    expect(() => circuit.beforeRequest(2_001)).not.toThrow();
  });
});

function createFixture() {
  const context = new TenantContextService();
  const session = {
    withTransaction: vi.fn(
      (operation: () => Promise<unknown>) => operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
  };
  const runs = {
    findOneAndUpdate: vi.fn().mockReturnValue(mongoQuery(null)),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    aggregate: vi.fn().mockReturnValue(mongoQuery([])),
  };
  const attempts = {
    create: vi.fn().mockResolvedValue(undefined),
  };
  const gateway = {
    start: vi.fn<
      (input: unknown) => Promise<KnowledgeExamStartReceipt>
    >(),
    timeout: vi.fn<
      (input: unknown) => Promise<KnowledgeExamTimeoutReceipt>
    >(),
    finalize: vi.fn<
      (input: unknown) => Promise<KnowledgeExamFinalizationReceipt>
    >(),
    status: vi.fn<
      (input: unknown) => Promise<KnowledgeExamFinalizationReceipt>
    >(),
  };
  const metrics = {
    recordKnowledgeExamRun: vi.fn(),
    observeKnowledgeExamGrading: vi.fn(),
    setKnowledgeExamRunBacklog: vi.fn(),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  const audit = {
    recordSystem: vi.fn().mockResolvedValue(undefined),
  };
  const service = new KnowledgeExamRunRelayService(
    connection as never,
    runs as never,
    attempts as never,
    gateway,
    metrics as never,
    context,
    outbox as never,
    audit as never,
  );
  return {
    service,
    context,
    session,
    connection,
    runs,
    attempts,
    gateway,
    metrics,
    outbox,
    audit,
  };
}

type Fixture = ReturnType<typeof createFixture>;

function queueFindOneAndUpdate(
  fixture: Fixture,
  ...values: readonly unknown[]
): void {
  for (const value of values) {
    fixture.runs.findOneAndUpdate.mockReturnValueOnce(mongoQuery(value));
  }
}

function mongoQuery<T>(value: T, valueIsPromise = false) {
  const query = {
    lean: vi.fn(),
    exec: vi.fn().mockImplementation(() =>
      valueIsPromise ? value : Promise.resolve(value),
    ),
  };
  query.lean.mockReturnValue(query);
  return query;
}

function lastFindUpdate(
  fixture: Fixture,
): Readonly<Record<string, unknown>> {
  const calls = fixture.runs.findOneAndUpdate.mock.calls;
  const update = calls.at(-1)?.[1] as {
    readonly $set?: Readonly<Record<string, unknown>>;
  } | undefined;
  return update?.$set ?? {};
}

function updateOneFilter(
  fixture: Fixture,
): Readonly<Record<string, unknown>> {
  return fixture.runs.updateOne.mock.calls.at(-1)?.[0] as
    | Readonly<Record<string, unknown>>
    | undefined
    ?? {};
}

function updateOneFields(
  fixture: Fixture,
): Readonly<Record<string, unknown>> {
  const update = fixture.runs.updateOne.mock.calls.at(-1)?.[1] as {
    readonly $set?: Readonly<Record<string, unknown>>;
  } | undefined;
  return update?.$set ?? {};
}

function outboxEvent(
  fixture: Fixture,
): Readonly<Record<string, unknown>> {
  return fixture.outbox.append.mock.calls.at(-1)?.[0] as
    | Readonly<Record<string, unknown>>
    | undefined
    ?? {};
}
