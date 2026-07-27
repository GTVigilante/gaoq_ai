import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { EmploymentRepository } from '../../org/persistence/org.repositories.js';
import {
  createCourseVersion,
  createKnowledgeExamRun,
  createTrainingAssignment,
  publishCourseVersion,
  type CourseVersion,
  type KnowledgeExamRun,
  type TrainingAssignment,
} from '../domain/index.js';
import type { KnowledgeExamRunRepository } from '../persistence/knowledge-exam-run.repository.js';
import type { KnowledgeOutboxWriter } from '../persistence/knowledge-outbox.writer.js';
import type {
  CourseVersionRepository,
  TrainingAssignmentRepository,
} from '../persistence/knowledge.repositories.js';
import { KnowledgeExamRunService } from './knowledge-exam-run.service.js';

const SESSION = {} as ClientSession;
const NOW = new Date('2026-07-27T00:00:00.000Z');
const SUBMISSION_REF = '01J8ZQK7V0A2M4N6P8R0T2W4B2';
const OTHER_SUBMISSION_REF = '01J8ZQK7V0A2M4N6P8R0T2W4B3';

function fixture(options?: {
  readonly onboardingInstanceId?: string;
  readonly initialRun?: KnowledgeExamRun;
  readonly assignment?: TrainingAssignment;
  readonly course?: CourseVersion | null;
}) {
  const context = new TenantContextService();
  const onboardingInstanceId = options?.onboardingInstanceId ?? 'onboarding-001';
  const assignment = options?.assignment ?? createTrainingAssignment({
    id: 'assignment-001',
    tenantId: 'tenant-001',
    onboardingInstanceId,
    courseVersionId: 'course-001',
    mandatory: true,
    examRequired: true,
    dueDate: '2026-08-31',
    coursePublished: true,
  }, NOW);
  const course = options?.course === undefined ? publishCourseVersion(createCourseVersion({
    id: 'course-001',
    tenantId: 'tenant-001',
    courseCode: 'MIXED_SECURITY',
    revision: 1,
    title: '混合题安全培训',
    contentRef: 'content-001',
    questionBankRef: 'bank-001',
    questionBankDigest: 'a'.repeat(43),
    passingScoreBps: 8_000,
    questionMode: 'mixed',
    timeLimitMinutes: 90,
    maxAttempts: 2,
    gradingPolicyVersion: 'mixed-manual-v2',
    passingRule: 'all_required_sections',
    gradingSlaMinutes: 5,
    manualReviewSlaMinutes: 1_440,
  }, NOW), {
    tenantId: 'tenant-001',
    expectedVersion: 1,
    contentVerified: true,
    questionBankVerified: true,
  }, NOW) : options.course;
  let run = options?.initialRun ?? null;
  const runs = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(run)),
    findActiveByAssignment: vi.fn().mockImplementation(() => Promise.resolve(
      run !== null &&
      ['starting', 'in_progress', 'submitted', 'pending_review'].includes(run.status)
        ? run
        : null,
    )),
    nextAttemptNumber: vi.fn().mockResolvedValue(1),
    insert: vi.fn().mockImplementation((value: KnowledgeExamRun) => {
      run = value;
      return Promise.resolve();
    }),
    submit: vi.fn(),
  };
  const idempotency = {
    execute: vi.fn().mockImplementation(
      async (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: ClientSession) => Promise<unknown>,
      ) => handler(SESSION),
    ),
  };
  const courses = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(course)),
  };
  const assignments = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(assignment)),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue('event-001'),
  };
  const profiles = {
    resolveActive: vi.fn().mockResolvedValue({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      employeeId: 'employee-001',
      status: 'active',
      roleCodes: [],
      scopes: [],
      departmentIds: ['department-001'],
      version: 1,
    }),
  };
  const employments = {
    findOpenByEmployeeId: vi.fn().mockResolvedValue({
      id: 'employment-001',
      tenantId: 'tenant-001',
      personId: 'person-001',
      employeeId: 'employee-001',
      onboardingInstanceId: 'onboarding-001',
      status: 'active',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      version: 1,
    }),
  };
  const service = new KnowledgeExamRunService(
    idempotency as unknown as IdempotencyService,
    context,
    courses as unknown as CourseVersionRepository,
    assignments as unknown as TrainingAssignmentRepository,
    runs as unknown as KnowledgeExamRunRepository,
    outbox as unknown as KnowledgeOutboxWriter,
    profiles as unknown as AccessProfileRepository,
    employments as unknown as EmploymentRepository,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorType: 'user' as const,
      actorId: 'actor-001',
      tenantId: 'tenant-001',
      roleCodes: [],
      scopes: [
        'erp:knowledge:exam:start',
        'erp:knowledge:exam:submit',
        'erp:knowledge:exam:read',
      ],
      departmentIds: ['department-001'],
      traceId: 'trace-001',
    },
  };
  return {
    context,
    trusted,
    service,
    runs,
    idempotency,
    courses,
    assignments,
    outbox,
    profiles,
    employments,
    assignment,
    course,
  };
}

function submittedRun(): KnowledgeExamRun {
  const created = createKnowledgeExamRun({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    tenantId: 'tenant-001',
    assignmentId: 'assignment-001',
    courseVersionId: 'course-001',
    questionBankRef: 'bank-001',
    questionBankDigest: 'a'.repeat(43),
    attemptNumber: 1,
    questionMode: 'mixed',
    gradingPolicyVersion: 'mixed-manual-v2',
    passingRule: 'all_required_sections',
    passingScoreBps: 8_000,
    maxAttempts: 2,
    timeLimitMinutes: 90,
    manualReviewRequired: true,
    gradingSlaMinutes: 5,
    manualReviewSlaMinutes: 1_440,
  }, NOW);
  return Object.freeze({
    ...created,
    status: 'submitted',
    gatewaySessionRef: 'session-001',
    submissionRef: SUBMISSION_REF,
    questionSetDigest: 'b'.repeat(43),
    startedAt: NOW.toISOString(),
    deadlineAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    submittedAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    submissionReason: 'learner',
    nextActionAt: NOW.toISOString(),
    version: 3,
  });
}

function inProgressRun(): KnowledgeExamRun {
  const created = createKnowledgeExamRun({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    tenantId: 'tenant-001',
    assignmentId: 'assignment-001',
    courseVersionId: 'course-001',
    questionBankRef: 'bank-001',
    questionBankDigest: 'a'.repeat(43),
    attemptNumber: 1,
    questionMode: 'mixed',
    gradingPolicyVersion: 'mixed-manual-v2',
    passingRule: 'all_required_sections',
    passingScoreBps: 8_000,
    maxAttempts: 2,
    timeLimitMinutes: 90,
    manualReviewRequired: true,
    gradingSlaMinutes: 5,
    manualReviewSlaMinutes: 1_440,
  }, NOW);
  return Object.freeze({
    ...created,
    status: 'in_progress',
    gatewaySessionRef: 'session-001',
    questionSetDigest: 'b'.repeat(43),
    startedAt: NOW.toISOString(),
    deadlineAt: '2999-01-01T00:00:00.000Z',
    nextActionAt: '2999-01-01T00:00:00.000Z',
    version: 2,
  });
}

describe('KnowledgeExamRunService', () => {
  it('开始考试锁定版本化策略且响应不暴露题库、提交或证据引用', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () =>
      store.service.start('assignment-001', 'exam-start-001'),
    );
    expect(result.examRun).toMatchObject({
      questionMode: 'mixed',
      gradingPolicyVersion: 'mixed-manual-v2',
      passingRule: 'all_required_sections',
      manualReviewRequired: true,
      status: 'starting',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /questionBank|submissionRef|gatewaySession|reviewEvidence|gradingEvidence/iu,
    );
    expect(store.runs.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        assignmentId: 'assignment-001',
        attemptNumber: 1,
      }),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.run.requested' }),
      SESSION,
    );
  });

  it('开始考试在事务前后均对任务存在性失败关闭', async () => {
    const missingSnapshot = fixture();
    missingSnapshot.assignments.findById.mockResolvedValueOnce(null);
    await expect(missingSnapshot.context.run(missingSnapshot.trusted, () =>
      missingSnapshot.service.start('assignment-missing', 'exam-start-missing')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
      });
    expect(missingSnapshot.idempotency.execute).not.toHaveBeenCalled();

    const missingInTransaction = fixture();
    missingInTransaction.assignments.findById
      .mockResolvedValueOnce(missingInTransaction.assignment)
      .mockResolvedValueOnce(null);
    await expect(missingInTransaction.context.run(missingInTransaction.trusted, () =>
      missingInTransaction.service.start('assignment-001', 'exam-start-raced')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
      });
  });

  it('已有活动考试时在创建新尝试前稳定返回既有运行', async () => {
    const run = inProgressRun();
    const store = fixture({ initialRun: run });
    const result = await store.context.run(store.trusted, () =>
      store.service.start('assignment-001', 'exam-start-active'),
    );

    expect(result.examRun).toMatchObject({
      id: run.id,
      status: 'in_progress',
      version: 2,
    });
    expect(store.runs.nextAttemptNumber).not.toHaveBeenCalled();
    expect(store.runs.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each(['completed', 'expired'] as const)(
    '终态任务 %s 不允许开始考试',
    async (status) => {
      const base = fixture();
      const store = fixture({
        assignment: { ...base.assignment, status },
      });

      await expect(store.context.run(store.trusted, () =>
        store.service.start('assignment-001', `exam-start-${status}`)))
        .rejects.toMatchObject({
          response: { code: 'KNOWLEDGE_ASSIGNMENT_TERMINAL' },
        });
      expect(store.courses.findById).not.toHaveBeenCalled();
    },
  );

  it('考试策略任一必需事实缺失时均拒绝创建运行', async () => {
    const base = fixture();
    if (base.course === null) throw new Error('测试课程不存在');
    const cases: readonly {
      readonly label: string;
      readonly course: CourseVersion | null;
      readonly examRequired?: boolean;
    }[] = [
      { label: '课程不存在', course: null },
      { label: '任务免试', course: base.course, examRequired: false },
      { label: '题库引用', course: { ...base.course, questionBankRef: null } },
      { label: '题库摘要', course: { ...base.course, questionBankDigest: null } },
      { label: '题型策略', course: { ...base.course, questionMode: null } },
      { label: '评分策略版本', course: { ...base.course, gradingPolicyVersion: null } },
      { label: '及格分', course: { ...base.course, passingScoreBps: null } },
      { label: '最大次数', course: { ...base.course, maxAttempts: null } },
      { label: '答题时限', course: { ...base.course, timeLimitMinutes: null } },
      { label: '通过规则', course: { ...base.course, passingRule: null } },
      { label: '自动评分 SLA', course: { ...base.course, gradingSlaMinutes: null } },
      { label: '人工复核 SLA', course: { ...base.course, manualReviewSlaMinutes: null } },
    ];

    for (const item of cases) {
      const store = fixture({
        course: item.course,
        assignment: item.examRequired === false
          ? { ...base.assignment, examRequired: false }
          : base.assignment,
      });
      await expect(store.context.run(store.trusted, () =>
        store.service.start('assignment-001', `exam-start-unconfigured-${item.label}`)))
        .rejects.toMatchObject({
          response: { code: 'KNOWLEDGE_EXAM_NOT_CONFIGURED' },
        });
      expect(store.runs.insert).not.toHaveBeenCalled();
    }
  });

  it('达到最大考试次数后拒绝创建额外尝试', async () => {
    const store = fixture();
    store.runs.nextAttemptNumber.mockResolvedValueOnce(3);

    await expect(store.context.run(store.trusted, () =>
      store.service.start('assignment-001', 'exam-start-exhausted')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_ATTEMPTS_EXHAUSTED' },
      });
    expect(store.runs.insert).not.toHaveBeenCalled();
  });

  it('活动运行唯一键竞争只恢复当前任务的活动事实', async () => {
    const active = inProgressRun();
    const recovered = fixture();
    recovered.runs.findActiveByAssignment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(active);
    recovered.runs.insert.mockRejectedValueOnce({ code: 11_000 });

    await expect(recovered.context.run(recovered.trusted, () =>
      recovered.service.start('assignment-001', 'exam-start-race')))
      .resolves.toMatchObject({
        examRun: { id: active.id, status: 'in_progress' },
      });

    const missing = fixture();
    missing.runs.findActiveByAssignment.mockResolvedValue(null);
    missing.runs.insert.mockRejectedValueOnce({ code: 11_000 });
    await expect(missing.context.run(missing.trusted, () =>
      missing.service.start('assignment-001', 'exam-start-race-missing')))
      .rejects.toMatchObject({ code: 11_000 });

    const unrelated = fixture();
    unrelated.runs.insert.mockRejectedValueOnce(new Error('数据库不可用'));
    await expect(unrelated.context.run(unrelated.trusted, () =>
      unrelated.service.start('assignment-001', 'exam-start-database-error')))
      .rejects.toThrow('数据库不可用');
    expect(unrelated.runs.findActiveByAssignment).toHaveBeenCalledOnce();
  });

  it('受信管理服务必须同时具有管理 Scope', async () => {
    const allowed = fixture();
    const serviceActor = {
      tenant: allowed.trusted.tenant,
      actor: {
        ...allowed.trusted.actor,
        actorType: 'service' as const,
        scopes: [...allowed.trusted.actor.scopes, 'erp:knowledge:exam:admin'],
      },
    };
    await expect(allowed.context.run(serviceActor, () =>
      allowed.service.start('assignment-001', 'exam-start-admin')))
      .resolves.toHaveProperty('examRun');
    expect(allowed.profiles.resolveActive).not.toHaveBeenCalled();

    const denied = fixture();
    const unprivilegedService = {
      tenant: denied.trusted.tenant,
      actor: {
        ...denied.trusted.actor,
        actorType: 'service' as const,
      },
    };
    await expect(denied.context.run(unprivilegedService, () =>
      denied.service.start('assignment-001', 'exam-start-service-denied')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED' },
      });
  });

  it('员工授权快照或任职关系缺失时拒绝考试访问', async () => {
    const missingProfile = fixture();
    missingProfile.profiles.resolveActive.mockResolvedValueOnce(null);
    await expect(missingProfile.context.run(missingProfile.trusted, () =>
      missingProfile.service.start('assignment-001', 'exam-start-no-profile')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED' },
      });
    expect(missingProfile.employments.findOpenByEmployeeId).not.toHaveBeenCalled();

    const missingEmployment = fixture();
    missingEmployment.employments.findOpenByEmployeeId.mockResolvedValueOnce(null);
    await expect(missingEmployment.context.run(missingEmployment.trusted, () =>
      missingEmployment.service.start('assignment-001', 'exam-start-no-employment')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED' },
      });
  });

  it('缺少操作 Scope 时在任何仓储读取前拒绝', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, scopes: [] },
    };
    await expect(store.context.run(trusted, () =>
      store.service.start('assignment-001', 'exam-start-no-scope')))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_SCOPE_REQUIRED' },
      });
    expect(store.assignments.findById).not.toHaveBeenCalled();
  });

  it('相同提交引用即使使用新幂等键和旧版本也稳定返回既有状态', async () => {
    const run = submittedRun();
    const store = fixture({ initialRun: run });
    const result = await store.context.run(store.trusted, () =>
      store.service.submit(
        run.id,
        2,
        'exam-submit-retry-002',
        run.submissionRef ?? '',
      ),
    );
    expect(result.examRun).toMatchObject({ id: run.id, status: 'submitted', version: 3 });
    expect(store.runs.submit).not.toHaveBeenCalled();
  });

  it('提交在事务前后均对运行与任务存在性失败关闭', async () => {
    const run = inProgressRun();
    const missingRun = fixture({ initialRun: run });
    missingRun.runs.findById.mockResolvedValueOnce(null);
    await expect(missingRun.context.run(missingRun.trusted, () =>
      missingRun.service.submit(run.id, 2, 'exam-submit-no-run', SUBMISSION_REF)))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND' },
      });

    const missingAssignment = fixture({ initialRun: run });
    missingAssignment.assignments.findById.mockResolvedValueOnce(null);
    await expect(missingAssignment.context.run(missingAssignment.trusted, () =>
      missingAssignment.service.submit(
        run.id,
        2,
        'exam-submit-no-assignment',
        SUBMISSION_REF,
      )))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
      });

    const missingRunInTransaction = fixture({ initialRun: run });
    missingRunInTransaction.runs.findById
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(null);
    await expect(missingRunInTransaction.context.run(
      missingRunInTransaction.trusted,
      () => missingRunInTransaction.service.submit(
        run.id,
        2,
        'exam-submit-run-raced',
        SUBMISSION_REF,
      ),
    )).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND' },
    });

    const missingAssignmentInTransaction = fixture({ initialRun: run });
    missingAssignmentInTransaction.assignments.findById
      .mockResolvedValueOnce(missingAssignmentInTransaction.assignment)
      .mockResolvedValueOnce(null);
    await expect(missingAssignmentInTransaction.context.run(
      missingAssignmentInTransaction.trusted,
      () => missingAssignmentInTransaction.service.submit(
        run.id,
        2,
        'exam-submit-assignment-raced',
        SUBMISSION_REF,
      ),
    )).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
    });
  });

  it('提交要求活动状态与精确版本', async () => {
    const terminal = submittedRun();
    const terminalStore = fixture({ initialRun: terminal });
    await expect(terminalStore.context.run(terminalStore.trusted, () =>
      terminalStore.service.submit(
        terminal.id,
        terminal.version,
        'exam-submit-terminal',
        OTHER_SUBMISSION_REF,
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EXAM_RUN_STATE_CONFLICT' },
    });

    const active = inProgressRun();
    const versionStore = fixture({ initialRun: active });
    await expect(versionStore.context.run(versionStore.trusted, () =>
      versionStore.service.submit(
        active.id,
        1,
        'exam-submit-version',
        SUBMISSION_REF,
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EXAM_RUN_STATE_CONFLICT' },
    });
  });

  it.each([
    null,
    '2026-07-27T00:00:00.000Z',
  ])('截止时间为 %s 时拒绝人工提交', async (deadlineAt) => {
    const run = { ...inProgressRun(), deadlineAt };
    const store = fixture({ initialRun: run });

    await expect(store.context.run(store.trusted, () =>
      store.service.submit(run.id, 2, 'exam-submit-expired', SUBMISSION_REF)))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_EXPIRED' },
      });
    expect(store.runs.submit).not.toHaveBeenCalled();
  });

  it('并发提交未匹配时返回稳定状态冲突', async () => {
    const run = inProgressRun();
    const store = fixture({ initialRun: run });
    store.runs.submit.mockResolvedValueOnce(null);

    await expect(store.context.run(store.trusted, () =>
      store.service.submit(run.id, 2, 'exam-submit-race', SUBMISSION_REF)))
      .rejects.toMatchObject({
        response: { code: 'KNOWLEDGE_EXAM_RUN_STATE_CONFLICT' },
      });
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('有效提交与 Outbox 事件在同一幂等事务内形成终态', async () => {
    const run = inProgressRun();
    const updated = Object.freeze({
      ...run,
      status: 'submitted' as const,
      submissionRef: SUBMISSION_REF,
      submittedAt: new Date().toISOString(),
      submissionReason: 'learner' as const,
      version: 3,
    });
    const store = fixture({ initialRun: run });
    store.runs.submit.mockResolvedValueOnce(updated);

    const result = await store.context.run(store.trusted, () =>
      store.service.submit(run.id, 2, 'exam-submit-001', SUBMISSION_REF));
    expect(result.examRun).toMatchObject({
      id: run.id,
      status: 'submitted',
      version: 3,
    });
    expect(store.runs.submit).toHaveBeenCalledWith(
      run.id,
      2,
      SUBMISSION_REF,
      expect.any(Date),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.exam.run.submitted' }),
      SESSION,
    );
  });

  it('读取考试运行执行所有权检查并保持最小响应', async () => {
    const run = submittedRun();
    const store = fixture({ initialRun: run });
    const result = await store.context.run(store.trusted, () =>
      store.service.get(run.id));

    expect(result).toMatchObject({
      id: run.id,
      assignmentId: 'assignment-001',
      status: 'submitted',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /questionBank|submissionRef|gatewaySession|reviewEvidence|gradingEvidence/iu,
    );
  });

  it('读取对缺失运行与任务失败关闭', async () => {
    const missingRun = fixture();
    await expect(missingRun.context.run(missingRun.trusted, () =>
      missingRun.service.get('01J8ZQK7V0A2M4N6P8R0T2W4A1'))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EXAM_RUN_NOT_FOUND' },
    });

    const run = submittedRun();
    const missingAssignment = fixture({ initialRun: run });
    missingAssignment.assignments.findById.mockResolvedValueOnce(null);
    await expect(missingAssignment.context.run(missingAssignment.trusted, () =>
      missingAssignment.service.get(run.id))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
    });
  });

  it('有效身份不属于任务 Onboarding 时开始、提交与读取均失败关闭', async () => {
    const run = submittedRun();
    const store = fixture({
      onboardingInstanceId: 'onboarding-other',
      initialRun: run,
    });
    await expect(store.context.run(store.trusted, () =>
      store.service.start('assignment-001', 'exam-start-denied'),
    )).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED',
    } });
    await expect(store.context.run(store.trusted, () =>
      store.service.submit(run.id, 3, 'exam-submit-denied', run.submissionRef ?? ''),
    )).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED',
    } });
    await expect(store.context.run(store.trusted, () =>
      store.service.get(run.id),
    )).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_EXAM_RUN_OWNERSHIP_REQUIRED',
    } });
  });
});
