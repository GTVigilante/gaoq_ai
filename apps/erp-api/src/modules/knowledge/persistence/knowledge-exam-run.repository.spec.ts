import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { KnowledgeExamRun } from '../domain/index.js';
import type { KnowledgeExamRunDocument } from './knowledge-exam-run.schemas.js';
import { KnowledgeExamRunRepository } from './knowledge-exam-run.repository.js';

interface QueryStub {
  readonly select: Mock<(projection: string) => QueryStub>;
  readonly sort: Mock<(sort: Readonly<Record<string, number>>) => QueryStub>;
  readonly session: Mock<(session: ClientSession) => QueryStub>;
  readonly lean: Mock<() => QueryStub>;
  readonly exec: Mock<() => Promise<unknown>>;
}

type CreateRunRecords = (
  rows: readonly Readonly<Record<string, unknown>>[],
  options: { readonly session: ClientSession },
) => Promise<readonly unknown[]>;

const TENANT_ID = 'tenant-001';
const RUN_ID = 'exam-run-001';
const ASSIGNMENT_ID = 'assignment-001';
const CREATED_AT = '2026-07-29T00:00:00.000Z';
const STARTED_AT = '2026-07-29T00:01:00.000Z';
const DEADLINE_AT = '2026-07-29T01:01:00.000Z';
const SUBMITTED_AT = '2026-07-29T00:30:00.000Z';
const DIGEST = 'A'.repeat(43);
const QUESTION_SET_DIGEST = 'B'.repeat(43);
const session = {
  inTransaction: vi.fn(() => true),
} as unknown as ClientSession;

describe('KnowledgeExamRunRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'starting',
    'in_progress',
    'submitted',
    'pending_review',
    'graded',
    'dead',
  ] as const)('严格读取并深冻结 %s 状态', async (status) => {
    const domain = runForStatus(status);
    const { repository } = setup({ findOneResult: record(domain) });

    const result = await repository.findById(RUN_ID, session);

    expect(result).toEqual(domain);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('使用可信租户、最小投影和可选事务查询主键', async () => {
    const { repository, findOne, findOneQuery } = setup({
      findOneResult: record(runForStatus('starting')),
    });

    await repository.findById(RUN_ID, session);

    expect(findOne).toHaveBeenCalledWith({ tenantId: TENANT_ID, id: RUN_ID });
    expect(findOneQuery.select).toHaveBeenCalledTimes(1);
    expect(findOneQuery.select.mock.calls[0]![0]).toContain('questionBankDigest');
    expect(findOneQuery.select.mock.calls[0]![0]).toContain('-_id');
    expect(findOneQuery.session).toHaveBeenCalledWith(session);
  });

  it('未找到考试运行时返回 null', async () => {
    const { repository } = setup({ findOneResult: null });

    await expect(repository.findById(RUN_ID)).resolves.toBeNull();
  });

  it.each([
    [{ tenantId: 'tenant-002' }],
    [{ id: 'exam-run-002' }],
    [{ questionBankDigest: 'invalid' }],
    [{ attemptNumber: 4, maxAttempts: 3 }],
    [{ questionMode: 'mixed', manualReviewRequired: false }],
    [{ lockedAt: new Date(STARTED_AT), lockedBy: null }],
    [{ replayReason: 'GATEWAY_RECOVERED', replayedAt: null }],
    [{ status: 'graded', finalAttemptId: null }],
    [{ deadlineAt: new Date(STARTED_AT) }],
    [{ submittedAt: new Date('2026-07-29T02:00:00.000Z') }],
  ])('拒绝受损、错租户或错对象的数据库投影 %#', async (overrides) => {
    const base = record(runForStatus('graded'));
    const { repository } = setup({
      findOneResult: { ...base, ...overrides },
    });

    await expect(repository.findById(RUN_ID)).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_RECORD_INVALID',
    );
  });

  it.each([
    [() => {
      throw new Error('缺少租户');
    }],
    [() => ({ tenantId: '../tenant' })],
    [() => null],
  ])('拒绝缺失或受损的可信租户上下文 %#', async (getTenantRequired) => {
    const { repository, findOne } = setup({ getTenantRequired });

    await expect(repository.findById(RUN_ID)).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_CONTEXT_INVALID',
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each(['', '../run', 'bad run'])('拒绝非法查询主键 %s', async (id) => {
    const { repository, findOne } = setup();

    await expect(repository.findById(id)).rejects.toThrow(
      'KNOWLEDGE_EXAM_RUN_INPUT_INVALID',
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each(['starting', 'in_progress', 'submitted', 'pending_review'] as const)(
    '只返回与任务反向绑定的活动状态 %s',
    async (status) => {
      const { repository, findOne } = setup({
        findOneResult: record(runForStatus(status)),
      });

      const result = await repository.findActiveByAssignment(ASSIGNMENT_ID, session);

      expect(result?.status).toBe(status);
      expect(findOne).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        assignmentId: ASSIGNMENT_ID,
        status: { $in: ['starting', 'in_progress', 'submitted', 'pending_review'] },
      });
    },
  );

  it.each([
    [record(runForStatus('graded'))],
    [record(runForStatus('dead'))],
    [{ ...record(runForStatus('starting')), assignmentId: 'assignment-002' }],
  ])('拒绝活动查询返回终态或错任务结果 %#', async (findOneResult) => {
    const { repository } = setup({ findOneResult });

    await expect(repository.findActiveByAssignment(ASSIGNMENT_ID))
      .rejects.toThrow('KNOWLEDGE_EXAM_RUN_RECORD_INVALID');
  });

  it('没有历史尝试时在活动事务内返回首次尝试号', async () => {
    const { repository, findOneQuery } = setup({ findOneResult: null });

    await expect(repository.nextAttemptNumber(ASSIGNMENT_ID, session)).resolves.toBe(1);
    expect(findOneQuery.select).toHaveBeenCalledWith(
      'tenantId assignmentId attemptNumber -_id',
    );
    expect(findOneQuery.sort).toHaveBeenCalledWith({ attemptNumber: -1 });
    expect(findOneQuery.session).toHaveBeenCalledWith(session);
  });

  it('对反向绑定的历史尝试分配后继序号', async () => {
    const { repository } = setup({
      findOneResult: {
        tenantId: TENANT_ID,
        assignmentId: ASSIGNMENT_ID,
        attemptNumber: 3,
      },
    });

    await expect(repository.nextAttemptNumber(ASSIGNMENT_ID, session)).resolves.toBe(4);
  });

  it.each([
    [{ tenantId: 'tenant-002', assignmentId: ASSIGNMENT_ID, attemptNumber: 1 }],
    [{ tenantId: TENANT_ID, assignmentId: 'assignment-002', attemptNumber: 1 }],
    [{ tenantId: TENANT_ID, assignmentId: ASSIGNMENT_ID, attemptNumber: 11 }],
    [{ tenantId: TENANT_ID, assignmentId: ASSIGNMENT_ID, attemptNumber: 1.5 }],
  ])('拒绝受损的历史尝试投影 %#', async (findOneResult) => {
    const { repository } = setup({ findOneResult });

    await expect(repository.nextAttemptNumber(ASSIGNMENT_ID, session))
      .rejects.toThrow('KNOWLEDGE_EXAM_RUN_RECORD_INVALID');
  });

  it.each([
    [null],
    [{}],
    [{ inTransaction: 'true' }],
    [{ inTransaction: () => false }],
    [{ inTransaction: () => {
      throw new Error('会话损坏');
    } }],
  ])('尝试号分配拒绝非活动事务 %#', async (candidate) => {
    const { repository, findOne } = setup();

    await expect(repository.nextAttemptNumber(
      ASSIGNMENT_ID,
      candidate as unknown as ClientSession,
    )).rejects.toThrow('KNOWLEDGE_EXAM_RUN_TRANSACTION_REQUIRED');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('在活动事务内写入规范化日期并验证创建回执', async () => {
    const domain = runForStatus('starting');
    const { repository, create } = setup();

    await repository.insert(domain, session);

    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows[0]).toMatchObject({
      id: RUN_ID,
      tenantId: TENANT_ID,
      status: 'starting',
      startedAt: null,
      deadlineAt: null,
      createdAt: new Date(CREATED_AT),
      lockedAt: null,
      lockedBy: null,
      replayReason: null,
      replayedAt: null,
    });
  });

  it('兼容 Mongoose Document 的 toObject 创建回执', async () => {
    const domain = runForStatus('starting');
    const { repository, create } = setup();
    create.mockImplementationOnce((rows) => Promise.resolve([{
      toObject: () => rows[0],
    }]));

    await expect(repository.insert(domain, session)).resolves.toBeUndefined();
  });

  it.each([
    [{ ...runForStatus('starting'), tenantId: 'tenant-002' },
      'KNOWLEDGE_EXAM_RUN_TENANT_MISMATCH'],
    [{ ...runForStatus('starting'), unknown: true },
      'KNOWLEDGE_EXAM_RUN_INPUT_INVALID'],
    [{ ...runForStatus('starting'), attemptNumber: 0 },
      'KNOWLEDGE_EXAM_RUN_INPUT_INVALID'],
    [{ ...runForStatus('starting'), updatedAt: '2026-07-28T23:59:00.000Z' },
      'KNOWLEDGE_EXAM_RUN_INPUT_INVALID'],
  ])('写入前拒绝非法实体 %#', async (candidate, errorCode) => {
    const { repository, create } = setup();

    await expect(repository.insert(
      candidate,
      session,
    )).rejects.toThrow(errorCode);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{}, {}]],
    [[{ id: 'wrong' }]],
  ])('拒绝无法反向绑定的创建回执 %#', async (created) => {
    const { repository, create } = setup();
    create.mockResolvedValueOnce(created);

    await expect(repository.insert(runForStatus('starting'), session))
      .rejects.toThrow('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
  });

  it('保留插入数据库异常供事务上层分类', async () => {
    const { repository, create } = setup();
    const failure = new Error('mongo unavailable');
    create.mockRejectedValueOnce(failure);

    await expect(repository.insert(runForStatus('starting'), session)).rejects.toBe(failure);
  });

  it('按版本、状态和未到期条件提交并反向验证新状态', async () => {
    const now = new Date(SUBMITTED_AT);
    const submitted = runForStatus('submitted', {
      version: 3,
      submittedAt: SUBMITTED_AT,
      updatedAt: SUBMITTED_AT,
      nextActionAt: SUBMITTED_AT,
    });
    const { repository, findOneAndUpdate, findOneAndUpdateQuery } = setup({
      findOneAndUpdateResult: record(submitted),
    });

    const result = await repository.submit(
      RUN_ID,
      2,
      'submission-001',
      now,
      session,
    );

    expect(result).toEqual(submitted);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        tenantId: TENANT_ID,
        id: RUN_ID,
        status: 'in_progress',
        version: 2,
        deadlineAt: { $gt: now },
      },
      {
        $set: {
          status: 'submitted',
          submissionRef: 'submission-001',
          submittedAt: now,
          submissionReason: 'learner',
          timedOut: false,
          nextActionAt: now,
          lastErrorCode: null,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      {
        session,
        returnDocument: 'after',
        timestamps: false,
        runValidators: true,
      },
    );
    expect(findOneAndUpdateQuery.select).toHaveBeenCalledTimes(1);
  });

  it('CAS 未命中时返回 null', async () => {
    const { repository } = setup({ findOneAndUpdateResult: null });

    await expect(repository.submit(
      RUN_ID,
      2,
      'submission-001',
      new Date(SUBMITTED_AT),
      session,
    )).resolves.toBeNull();
  });

  it.each([
    [{ tenantId: 'tenant-002' }],
    [{ id: 'exam-run-002' }],
    [{ status: 'pending_review' }],
    [{ version: 4 }],
    [{ submissionRef: 'submission-002' }],
    [{ submissionReason: 'timeout', timedOut: true }],
    [{ submittedAt: new Date('2026-07-29T00:31:00.000Z') }],
    [{ nextActionAt: new Date('2026-07-29T00:31:00.000Z') }],
    [{ updatedAt: new Date('2026-07-29T00:31:00.000Z') }],
  ])('拒绝错对象或错终态的提交回执 %#', async (overrides) => {
    const submitted = record(runForStatus('submitted', {
      version: 3,
      submittedAt: SUBMITTED_AT,
      updatedAt: SUBMITTED_AT,
      nextActionAt: SUBMITTED_AT,
    }));
    const { repository } = setup({
      findOneAndUpdateResult: { ...submitted, ...overrides },
    });

    await expect(repository.submit(
      RUN_ID,
      2,
      'submission-001',
      new Date(SUBMITTED_AT),
      session,
    )).rejects.toThrow('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
  });

  it.each([
    ['', 2, 'submission-001', new Date(SUBMITTED_AT)],
    [RUN_ID, 0, 'submission-001', new Date(SUBMITTED_AT)],
    [RUN_ID, Number.MAX_SAFE_INTEGER, 'submission-001', new Date(SUBMITTED_AT)],
    [RUN_ID, 2, 'bad submission', new Date(SUBMITTED_AT)],
    [RUN_ID, 2, 'submission-001', new Date('invalid')],
  ])('提交前拒绝非法参数 %#', async (id, version, submissionRef, now) => {
    const { repository, findOneAndUpdate } = setup();

    await expect(repository.submit(
      id,
      version,
      submissionRef,
      now,
      session,
    )).rejects.toThrow('KNOWLEDGE_EXAM_RUN_INPUT_INVALID');
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('保留提交数据库异常供事务上层分类', async () => {
    const { repository, findOneAndUpdateQuery } = setup();
    const failure = new Error('mongo unavailable');
    findOneAndUpdateQuery.exec.mockRejectedValueOnce(failure);

    await expect(repository.submit(
      RUN_ID,
      2,
      'submission-001',
      new Date(SUBMITTED_AT),
      session,
    )).rejects.toBe(failure);
  });
});

function setup(options: {
  readonly findOneResult?: unknown;
  readonly findOneAndUpdateResult?: unknown;
  readonly getTenantRequired?: () => unknown;
} = {}): {
  readonly repository: KnowledgeExamRunRepository;
  readonly findOne: Mock;
  readonly findOneAndUpdate: Mock;
  readonly create: Mock<CreateRunRecords>;
  readonly findOneQuery: QueryStub;
  readonly findOneAndUpdateQuery: QueryStub;
} {
  const findOneQuery = query(options.findOneResult ?? null);
  const findOneAndUpdateQuery = query(options.findOneAndUpdateResult ?? null);
  const findOne = vi.fn(() => findOneQuery);
  const findOneAndUpdate = vi.fn(() => findOneAndUpdateQuery);
  const create = vi.fn<CreateRunRecords>((rows) => Promise.resolve(rows));
  const context = {
    getTenantRequired: vi.fn(options.getTenantRequired ?? (() => ({
      tenantId: TENANT_ID,
      source: 'access_token',
    }))),
  } as unknown as TenantContextService;
  const records = {
    findOne,
    findOneAndUpdate,
    create,
  } as unknown as Model<KnowledgeExamRunDocument>;
  return {
    repository: new KnowledgeExamRunRepository(context, records),
    findOne,
    findOneAndUpdate,
    create,
    findOneQuery,
    findOneAndUpdateQuery,
  };
}

function query(result: unknown): QueryStub {
  const stub = {} as QueryStub;
  Object.assign(stub, {
    select: vi.fn(() => stub),
    sort: vi.fn(() => stub),
    session: vi.fn(() => stub),
    lean: vi.fn(() => stub),
    exec: vi.fn(() => Promise.resolve(result)),
  });
  return stub;
}

function runForStatus(
  status: KnowledgeExamRun['status'],
  overrides: Partial<KnowledgeExamRun> = {},
): KnowledgeExamRun {
  const base: KnowledgeExamRun = {
    id: RUN_ID,
    tenantId: TENANT_ID,
    assignmentId: ASSIGNMENT_ID,
    courseVersionId: 'course-version-001',
    questionBankRef: 'question-bank-001',
    questionBankDigest: DIGEST,
    attemptNumber: 2,
    questionMode: 'objective',
    gradingPolicyVersion: 'objective-v1',
    passingRule: 'score_threshold',
    passingScoreBps: 6_000,
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
    nextActionAt: CREATED_AT,
    lastErrorCode: null,
    version: 2,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const byStatus: Partial<KnowledgeExamRun> = status === 'starting'
    ? {}
    : status === 'in_progress'
      ? {
          gatewaySessionRef: 'gateway-session-001',
          questionSetDigest: QUESTION_SET_DIGEST,
          startedAt: STARTED_AT,
          deadlineAt: DEADLINE_AT,
          nextActionAt: DEADLINE_AT,
          updatedAt: STARTED_AT,
        }
      : status === 'submitted'
        ? {
            gatewaySessionRef: 'gateway-session-001',
            questionSetDigest: QUESTION_SET_DIGEST,
            startedAt: STARTED_AT,
            deadlineAt: DEADLINE_AT,
            submissionRef: 'submission-001',
            submittedAt: SUBMITTED_AT,
            submissionReason: 'learner',
            nextActionAt: SUBMITTED_AT,
            updatedAt: SUBMITTED_AT,
          }
        : status === 'pending_review'
          ? {
              questionMode: 'mixed',
              gradingPolicyVersion: 'mixed-v1',
              passingRule: 'all_required_sections',
              manualReviewRequired: true,
              gatewaySessionRef: 'gateway-session-001',
              questionSetDigest: QUESTION_SET_DIGEST,
              startedAt: STARTED_AT,
              deadlineAt: DEADLINE_AT,
              submissionRef: 'submission-001',
              submittedAt: SUBMITTED_AT,
              submissionReason: 'learner',
              reviewEvidenceId: 'review-evidence-001',
              reviewPolls: 1,
              nextActionAt: '2026-07-29T00:35:00.000Z',
              updatedAt: '2026-07-29T00:31:00.000Z',
            }
          : status === 'graded'
            ? {
                gatewaySessionRef: 'gateway-session-001',
                questionSetDigest: QUESTION_SET_DIGEST,
                startedAt: STARTED_AT,
                deadlineAt: DEADLINE_AT,
                submissionRef: 'submission-001',
                submittedAt: SUBMITTED_AT,
                submissionReason: 'learner',
                finalAttemptId: 'exam-attempt-002',
                nextActionAt: '2026-07-29T00:32:00.000Z',
                updatedAt: '2026-07-29T00:32:00.000Z',
              }
            : {
                attempts: 8,
                lastErrorCode: 'KNOWLEDGE_GATEWAY_UNAVAILABLE',
                nextActionAt: '2026-07-29T00:10:00.000Z',
                updatedAt: '2026-07-29T00:10:00.000Z',
              };
  return {
    ...base,
    ...byStatus,
    ...overrides,
    status,
  };
}

function record(run: KnowledgeExamRun): Readonly<Record<string, unknown>> {
  return {
    ...run,
    startedAt: date(run.startedAt),
    deadlineAt: date(run.deadlineAt),
    submittedAt: date(run.submittedAt),
    nextActionAt: new Date(run.nextActionAt),
    lockedAt: null,
    lockedBy: null,
    replayReason: null,
    replayedAt: null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function date(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}
