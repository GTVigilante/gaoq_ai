import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CourseVersion, ExamAttempt, TrainingAssignment } from '../domain/index.js';
import {
  CourseVersionRepository,
  ExamAttemptRepository,
  KnowledgeEvidenceRepository,
  KnowledgeWriteConflictError,
  TrainingAssignmentRepository,
} from './knowledge.repositories.js';
import type {
  KnowledgeCourseVersionDocument,
  KnowledgeExamAttemptDocument,
  KnowledgeOnboardingAttestationDocument,
  KnowledgeProgressEventDocument,
  KnowledgeTrainingAssignmentDocument,
} from './knowledge.schemas.js';

const tenantId = 'tenant-001';
const session = {} as ClientSession;
const now = '2026-07-27T00:00:00.000Z';

function context(): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId }),
  } as unknown as TenantContextService;
}

function courseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'course-version-001',
    tenantId,
    courseCode: 'SECURITY',
    revision: 1,
    title: '信息安全',
    contentRef: 'content-001',
    questionBankRef: 'bank-001',
    questionBankDigest: 'a'.repeat(43),
    passingScoreBps: 8_000,
    questionMode: 'mixed',
    timeLimitMinutes: 45,
    maxAttempts: 2,
    gradingPolicyVersion: 'mixed-v2',
    passingRule: 'all_required_sections',
    gradingSlaMinutes: 10,
    manualReviewSlaMinutes: 720,
    manualReviewRequired: true,
    audienceMode: 'employment_scope',
    audienceDepartmentIds: ['department-001'],
    audiencePositionIds: ['position-001'],
    status: 'published',
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

function legacyCourseRecords(): readonly Record<string, unknown>[] {
  return [
    courseRecord(),
    courseRecord({
      id: 'course-version-legacy-exam',
      questionMode: undefined,
      timeLimitMinutes: undefined,
      maxAttempts: undefined,
      gradingPolicyVersion: undefined,
      passingRule: undefined,
      gradingSlaMinutes: undefined,
      manualReviewSlaMinutes: undefined,
      manualReviewRequired: undefined,
      audienceMode: undefined,
      audienceDepartmentIds: undefined,
      audiencePositionIds: undefined,
    }),
    courseRecord({
      id: 'course-version-legacy-no-exam',
      questionBankRef: null,
      questionBankDigest: null,
      passingScoreBps: null,
      questionMode: undefined,
      timeLimitMinutes: undefined,
      maxAttempts: undefined,
      gradingPolicyVersion: undefined,
      passingRule: undefined,
      gradingSlaMinutes: undefined,
      manualReviewSlaMinutes: undefined,
      manualReviewRequired: undefined,
      audienceMode: undefined,
      audienceDepartmentIds: undefined,
      audiencePositionIds: undefined,
    }),
  ];
}

function assignmentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'assignment-001',
    tenantId,
    onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-version-001',
    mandatory: true,
    examRequired: true,
    dueDate: '2026-08-31',
    status: 'in_progress',
    progressBps: 5_000,
    passedExamAttemptId: null,
    completionEvidenceId: null,
    version: 2,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

function attemptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'attempt-001',
    tenantId,
    assignmentId: 'assignment-001',
    attemptNumber: 1,
    submissionRef: 'submission-001',
    questionSetDigest: 'b'.repeat(43),
    gradingEvidenceId: 'grading-evidence-001',
    questionMode: 'mixed',
    gradingPolicyVersion: 'mixed-v2',
    passingRule: 'all_required_sections',
    manualReviewEvidenceId: 'review-001',
    submissionReason: 'timeout',
    scoreBps: 8_500,
    passed: true,
    gradedAt: new Date(now),
    ...overrides,
  };
}

function queryFor(value: unknown): {
  readonly query: Record<string, ReturnType<typeof vi.fn>>;
  readonly exec: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn().mockResolvedValue(value);
  const query = {
    session: vi.fn(),
    lean: vi.fn(),
    exec,
  };
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return { query, exec };
}

describe('Knowledge 课程版本仓储', () => {
  it('按可信租户读取课程并兼容新旧考试配置', async () => {
    const modern = queryFor(courseRecord());
    const legacyExam = queryFor(legacyCourseRecords()[1]);
    const legacyNoExam = queryFor(legacyCourseRecords()[2]);
    const missing = queryFor(null);
    const findOne = vi.fn()
      .mockReturnValueOnce(modern.query)
      .mockReturnValueOnce(legacyExam.query)
      .mockReturnValueOnce(legacyNoExam.query)
      .mockReturnValueOnce(missing.query);
    const repository = new CourseVersionRepository(
      context(),
      { findOne } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await expect(repository.findById('course-version-001', session)).resolves.toMatchObject({
      questionMode: 'mixed',
      manualReviewRequired: true,
      audienceMode: 'employment_scope',
    });
    await expect(repository.findById('course-version-legacy-exam')).resolves.toMatchObject({
      questionMode: 'objective',
      timeLimitMinutes: 60,
      maxAttempts: 3,
      gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold',
      gradingSlaMinutes: 5,
      manualReviewSlaMinutes: 1_440,
      manualReviewRequired: false,
      audienceMode: 'assigned_only',
      audienceDepartmentIds: [],
      audiencePositionIds: [],
    });
    await expect(repository.findById('course-version-legacy-no-exam')).resolves.toMatchObject({
      questionMode: null,
      timeLimitMinutes: null,
      maxAttempts: null,
      gradingPolicyVersion: null,
      passingRule: null,
      gradingSlaMinutes: null,
      manualReviewSlaMinutes: null,
    });
    await expect(repository.findById('missing')).resolves.toBeNull();
    expect(modern.query.session).toHaveBeenCalledWith(session);
    expect(findOne).toHaveBeenNthCalledWith(1, { tenantId, id: 'course-version-001' });
  });

  it('批量读取课程，保留排序、事务与兼容映射', async () => {
    const result = queryFor(legacyCourseRecords());
    const sort = vi.fn().mockReturnValue(result.query);
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new CourseVersionRepository(
      context(),
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    const values = await repository.findByIds(
      ['course-version-001', 'course-version-legacy-exam'],
      session,
    );

    expect(values).toHaveLength(3);
    expect(values[1]).toMatchObject({ questionMode: 'objective', audienceDepartmentIds: [] });
    expect(values[2]).toMatchObject({ questionMode: null, timeLimitMinutes: null });
    expect(sort).toHaveBeenCalledWith({ id: 1 });
    expect(result.query.session).toHaveBeenCalledWith(session);
  });

  it('拒绝超量批量读取，空集合不访问数据库', async () => {
    const find = vi.fn();
    const repository = new CourseVersionRepository(
      context(),
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await expect(repository.findByIds([])).resolves.toEqual([]);
    await expect(repository.findByIds(Array.from({ length: 201 }, (_, index) => `${index}`)))
      .rejects.toThrow('知识课程批量读取超过 200 条上限');
    expect(find).not.toHaveBeenCalled();
  });

  it('强制可信租户，受众维度内 OR、维度间 AND', async () => {
    const exec = vi.fn().mockResolvedValue(legacyCourseRecords());
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new CourseVersionRepository(
      context(),
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    const values = await repository.findSearchEligible(
      ['assigned-course-001'],
      ['department-001'],
      ['position-001'],
    );

    expect(values[0]).toMatchObject({ questionMode: 'mixed' });
    expect(values[1]).toMatchObject({ questionMode: 'objective', audienceMode: 'assigned_only' });
    expect(values[2]).toMatchObject({ questionMode: null });
    expect(find).toHaveBeenCalledWith({
      tenantId,
      status: 'published',
      $or: [
        { id: { $in: ['assigned-course-001'] } },
        {
          audienceMode: 'employment_scope',
          $and: [
            {
              $or: [
                { audienceDepartmentIds: { $size: 0 } },
                { audienceDepartmentIds: { $in: ['department-001'] } },
              ],
            },
            {
              $or: [
                { audiencePositionIds: { $size: 0 } },
                { audiencePositionIds: { $in: ['position-001'] } },
              ],
            },
          ],
        },
      ],
    });
    expect(limit).toHaveBeenCalledWith(201);
  });

  it('支持单维任职授权投影并拒绝输入与结果超限', async () => {
    const exec = vi.fn().mockResolvedValue(Array.from({ length: 201 }, () => courseRecord()));
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new CourseVersionRepository(
      context(),
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await expect(repository.findSearchEligible([], ['department-001'], []))
      .rejects.toThrow('知识搜索授权课程超过 200 条上限');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      $or: [expect.objectContaining({
        $and: [
          expect.objectContaining({
            $or: [
              { audienceDepartmentIds: { $size: 0 } },
              { audienceDepartmentIds: { $in: ['department-001'] } },
            ],
          }),
          { $or: [{ audiencePositionIds: { $size: 0 } }] },
        ],
      })],
    }));
    await expect(repository.findSearchEligible([], [], ['position-001']))
      .rejects.toThrow('知识搜索授权课程超过 200 条上限');
    await expect(repository.findSearchEligible(Array(201).fill('course'), [], []))
      .rejects.toThrow('知识搜索授权投影超过上限');
    await expect(repository.findSearchEligible([], Array(501).fill('department'), []))
      .rejects.toThrow('知识搜索授权投影超过上限');
    await expect(repository.findSearchEligible([], [], Array(201).fill('position')))
      .rejects.toThrow('知识搜索授权投影超过上限');
  });

  it('不存在分配或任职授权投影时不访问数据库', async () => {
    const find = vi.fn();
    const repository = new CourseVersionRepository(
      context(),
      { find } as unknown as Model<KnowledgeCourseVersionDocument>,
    );

    await expect(repository.findSearchEligible([], [], [])).resolves.toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('新增和替换课程时校验租户并执行乐观锁', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CourseVersionRepository(
      context(),
      { create, updateOne } as unknown as Model<KnowledgeCourseVersionDocument>,
    );
    const course = {
      ...courseRecord(),
      createdAt: now,
      updatedAt: now,
    } as unknown as CourseVersion;

    await repository.insert(course, session);
    await repository.replace({ ...course, title: '信息安全 2', version: 2 }, 1, session);
    await expect(repository.replace({ ...course, version: 3 }, 1, session))
      .rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    await expect(repository.insert({ ...course, tenantId: 'tenant-other' }, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    await expect(repository.replace({ ...course, tenantId: 'tenant-other' }, 1, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({
        audienceDepartmentIds: ['department-001'],
        audiencePositionIds: ['position-001'],
        createdAt: new Date(now),
      })],
      { session },
    );
    expect(updateOne).toHaveBeenCalledWith(
      { tenantId, id: course.id, version: 1 },
      {
        $set: {
          title: '信息安全 2',
          status: course.status,
          version: 2,
          updatedAt: new Date(now),
        },
      },
      { session, timestamps: false, runValidators: true },
    );
  });
});

describe('Knowledge 培训任务仓储', () => {
  it('读取单条与入职实例任务并绑定可选事务', async () => {
    const found = queryFor(assignmentRecord());
    const missing = queryFor(null);
    const listed = queryFor([assignmentRecord()]);
    const findOne = vi.fn().mockReturnValueOnce(found.query).mockReturnValueOnce(missing.query);
    const limit = vi.fn().mockReturnValue(listed.query);
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new TrainingAssignmentRepository(
      context(),
      { findOne, find } as unknown as Model<KnowledgeTrainingAssignmentDocument>,
    );

    await expect(repository.findById('assignment-001', session)).resolves.toMatchObject({
      id: 'assignment-001',
      progressBps: 5_000,
      createdAt: now,
    });
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findByOnboarding('onboarding-001', session))
      .resolves.toEqual([expect.objectContaining({ id: 'assignment-001' })]);
    expect(found.query.session).toHaveBeenCalledWith(session);
    expect(listed.query.session).toHaveBeenCalledWith(session);
    expect(limit).toHaveBeenCalledWith(201);
  });

  it('拒绝单个入职实例超过 200 个任务', async () => {
    const listed = queryFor(Array.from({ length: 201 }, () => assignmentRecord()));
    const limit = vi.fn().mockReturnValue(listed.query);
    const sort = vi.fn().mockReturnValue({ limit });
    const repository = new TrainingAssignmentRepository(
      context(),
      { find: vi.fn().mockReturnValue({ sort }) } as unknown as Model<KnowledgeTrainingAssignmentDocument>,
    );

    await expect(repository.findByOnboarding('onboarding-001'))
      .rejects.toThrow('单个入职实例培训任务超过 200 条上限');
  });

  it('新增和替换任务时校验租户并执行乐观锁', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new TrainingAssignmentRepository(
      context(),
      { create, updateOne } as unknown as Model<KnowledgeTrainingAssignmentDocument>,
    );
    const assignment = {
      ...assignmentRecord(),
      createdAt: now,
      updatedAt: now,
    } as unknown as TrainingAssignment;

    await repository.insert(assignment, session);
    await repository.replace({ ...assignment, status: 'completed', version: 3 }, 2, session);
    await expect(repository.replace({ ...assignment, version: 4 }, 2, session))
      .rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    await expect(repository.insert({ ...assignment, tenantId: 'tenant-other' }, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    await expect(repository.replace({ ...assignment, tenantId: 'tenant-other' }, 2, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({ createdAt: new Date(now), updatedAt: new Date(now) })],
      { session },
    );
  });
});

describe('Knowledge 考试尝试仓储', () => {
  it('按标识与提交引用读取并兼容旧评分字段', async () => {
    const modern = queryFor(attemptRecord());
    const legacy = queryFor(attemptRecord({
      id: 'attempt-legacy',
      questionMode: undefined,
      gradingPolicyVersion: undefined,
      passingRule: undefined,
      manualReviewEvidenceId: undefined,
      submissionReason: undefined,
    }));
    const missing = queryFor(null);
    const missingSubmission = queryFor(null);
    const findOne = vi.fn()
      .mockReturnValueOnce(modern.query)
      .mockReturnValueOnce(missing.query)
      .mockReturnValueOnce(legacy.query)
      .mockReturnValueOnce(missingSubmission.query);
    const repository = new ExamAttemptRepository(
      context(),
      { findOne } as unknown as Model<KnowledgeExamAttemptDocument>,
    );

    await expect(repository.findById('attempt-001', session)).resolves.toMatchObject({
      questionMode: 'mixed',
      submissionReason: 'timeout',
    });
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findBySubmissionRef('submission-legacy', session)).resolves.toMatchObject({
      questionMode: 'objective',
      gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold',
      manualReviewEvidenceId: null,
      submissionReason: 'learner',
    });
    await expect(repository.findBySubmissionRef('missing')).resolves.toBeNull();
    expect(modern.query.session).toHaveBeenCalledWith(session);
    expect(legacy.query.session).toHaveBeenCalledWith(session);
  });

  it('计算下一尝试序号并统计任务尝试数', async () => {
    const latest = queryFor(attemptRecord({ attemptNumber: 4 }));
    const first = queryFor(null);
    const sort = vi.fn()
      .mockReturnValueOnce(latest.query)
      .mockReturnValueOnce(first.query);
    const findOne = vi.fn().mockReturnValue({ sort });
    const countExec = vi.fn().mockResolvedValue(5);
    const countDocuments = vi.fn().mockReturnValue({ exec: countExec });
    const repository = new ExamAttemptRepository(
      context(),
      { findOne, countDocuments } as unknown as Model<KnowledgeExamAttemptDocument>,
    );

    await expect(repository.nextAttemptNumber('assignment-001', session)).resolves.toBe(5);
    await expect(repository.nextAttemptNumber('assignment-new', session)).resolves.toBe(1);
    await expect(repository.countByAssignment('assignment-001')).resolves.toBe(5);
    expect(countDocuments).toHaveBeenCalledWith({ tenantId, assignmentId: 'assignment-001' });
  });

  it('新增尝试时转换日期并拒绝跨租户实体', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const repository = new ExamAttemptRepository(
      context(),
      { create } as unknown as Model<KnowledgeExamAttemptDocument>,
    );
    const attempt = {
      ...attemptRecord(),
      gradedAt: now,
    } as unknown as ExamAttempt;

    await repository.insert(attempt, session);
    await expect(repository.insert({ ...attempt, tenantId: 'tenant-other' }, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({ gradedAt: new Date(now) })],
      { session },
    );
  });
});

describe('Knowledge 证据仓储', () => {
  it('读取并追加进度事件', async () => {
    const found = queryFor({ assignmentId: 'assignment-001', progressBps: 6_000 });
    const missing = queryFor(null);
    const findOne = vi.fn().mockReturnValueOnce(found.query).mockReturnValueOnce(missing.query);
    const create = vi.fn().mockResolvedValue([]);
    const repository = new KnowledgeEvidenceRepository(
      context(),
      { findOne, create } as unknown as Model<KnowledgeProgressEventDocument>,
      {} as Model<KnowledgeOnboardingAttestationDocument>,
    );
    const input = {
      id: 'progress-001',
      tenantId,
      assignmentId: 'assignment-001',
      source: 'lms',
      sourceEventId: 'event-001',
      progressBps: 6_000,
      occurredAt: now,
    };

    await expect(repository.findProgressEvent('lms', 'event-001', session))
      .resolves.toEqual({ assignmentId: 'assignment-001', progressBps: 6_000 });
    await expect(repository.findProgressEvent('lms', 'missing', session)).resolves.toBeNull();
    await repository.appendProgress(input, session);
    await expect(repository.appendProgress({ ...input, tenantId: 'tenant-other' }, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({ occurredAt: new Date(now) })],
      { session },
    );
  });

  it('读取并新增入职培训证明', async () => {
    const found = queryFor({ id: 'attestation-001', digest: 'c'.repeat(43) });
    const missing = queryFor(null);
    const findOne = vi.fn().mockReturnValueOnce(found.query).mockReturnValueOnce(missing.query);
    const create = vi.fn().mockResolvedValue([]);
    const repository = new KnowledgeEvidenceRepository(
      context(),
      {} as Model<KnowledgeProgressEventDocument>,
      { findOne, create } as unknown as Model<KnowledgeOnboardingAttestationDocument>,
    );
    const input = {
      id: 'attestation-001',
      tenantId,
      onboardingInstanceId: 'onboarding-001',
      digest: 'c'.repeat(43),
      assignmentCount: 2,
      attestedAt: now,
    };

    await expect(repository.findAttestation('onboarding-001', session))
      .resolves.toEqual({ id: 'attestation-001', digest: 'c'.repeat(43) });
    await expect(repository.findAttestation('missing')).resolves.toBeNull();
    await repository.insertAttestation(input, session);
    await expect(repository.insertAttestation({ ...input, tenantId: 'tenant-other' }, session))
      .rejects.toThrow('Knowledge 仓储拒绝跨租户实体');
    expect(found.query.session).toHaveBeenCalledWith(session);
    expect(create).toHaveBeenCalledWith(
      [expect.objectContaining({ attestedAt: new Date(now) })],
      { session },
    );
  });
});
