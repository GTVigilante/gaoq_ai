import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OnboardingApplicationService } from '../../onboarding/application/onboarding-application.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type {
  EmployeeRepository,
  EmploymentRepository,
} from '../../org/persistence/org.repositories.js';
import {
  createCourseVersion,
  createTrainingAssignment,
  publishCourseVersion,
  recordTrainingProgress,
  type CourseVersion,
  type ExamAttempt,
  type TrainingAssignment,
} from '../domain/index.js';
import type { KnowledgeOutboxWriter } from '../persistence/knowledge-outbox.writer.js';
import type { KnowledgeSearchIndexTaskWriter } from '../persistence/knowledge-search-index-task.writer.js';
import {
  KnowledgeWriteConflictError,
  type CourseVersionRepository,
  type ExamAttemptRepository,
  type KnowledgeEvidenceRepository,
  type TrainingAssignmentRepository,
} from '../persistence/knowledge.repositories.js';
import { KnowledgeApplicationService } from './knowledge-application.service.js';

const SESSION = {} as ClientSession;
const NOW = new Date('2026-07-21T00:00:00.000Z');

function publishedCourse(): CourseVersion {
  const draft = createCourseVersion({
    id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
    title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
    questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
  }, NOW);
  return publishCourseVersion(draft, {
    tenantId: 'tenant-001', expectedVersion: 1,
    contentVerified: true, questionBankVerified: true,
  }, NOW);
}

function completedContentAssignment(): TrainingAssignment {
  return recordTrainingProgress(createTrainingAssignment({
    id: 'assignment-001', tenantId: 'tenant-001', onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-001', mandatory: true, examRequired: true,
    dueDate: '2026-08-31', coursePublished: true,
  }, NOW), { tenantId: 'tenant-001', expectedVersion: 1, progressBps: 10_000 }, NOW);
}

function completedContentOnlyAssignment(mandatory = true): TrainingAssignment {
  return recordTrainingProgress(createTrainingAssignment({
    id: 'assignment-001', tenantId: 'tenant-001', onboardingInstanceId: 'onboarding-001',
    courseVersionId: 'course-001', mandatory, examRequired: false,
    dueDate: '2026-08-31', coursePublished: true,
  }, NOW), { tenantId: 'tenant-001', expectedVersion: 1, progressBps: 10_000 }, NOW);
}

function fixture(options?: {
  readonly course?: CourseVersion;
  readonly assignment?: TrainingAssignment;
  readonly attempt?: ExamAttempt;
}) {
  const context = new TenantContextService();
  let course = options?.course ?? publishedCourse();
  let assignment = options?.assignment ?? completedContentAssignment();
  let attempt = options?.attempt ?? null;
  let attestation: { readonly id: string; readonly digest: string } | null = null;
  const courses = {
    findById: vi.fn().mockImplementation((id: string) => Promise.resolve(id === course.id ? course : null)),
    findByIds: vi.fn().mockImplementation((ids: readonly string[]) =>
      Promise.resolve(ids.includes(course.id) ? [course] : [])),
    findSearchEligible: vi.fn().mockImplementation(() => Promise.resolve(
      course.status === 'published' ? [course] : [],
    )),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockImplementation((value: CourseVersion) => { course = value; return Promise.resolve(); }),
  };
  const assignments = {
    findById: vi.fn().mockImplementation((id: string) => Promise.resolve(id === assignment.id ? assignment : null)),
    findByOnboarding: vi.fn().mockImplementation(() => Promise.resolve([assignment])),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockImplementation((value: TrainingAssignment) => {
      assignment = value;
      return Promise.resolve();
    }),
  };
  const attempts = {
    findById: vi.fn().mockImplementation((id: string) => Promise.resolve(attempt?.id === id ? attempt : null)),
    findBySubmissionRef: vi.fn().mockImplementation((ref: string) =>
      Promise.resolve(attempt?.submissionRef === ref ? attempt : null)),
    nextAttemptNumber: vi.fn().mockResolvedValue(1),
    countByAssignment: vi.fn().mockResolvedValue(0),
    insert: vi.fn().mockImplementation((value: ExamAttempt) => { attempt = value; return Promise.resolve(); }),
  };
  const evidence = {
    findProgressEvent: vi.fn().mockResolvedValue(null),
    appendProgress: vi.fn().mockResolvedValue(undefined),
    findAttestation: vi.fn().mockImplementation(() => Promise.resolve(attestation)),
    insertAttestation: vi.fn().mockImplementation((value: { id: string; digest: string }) => {
      attestation = { id: value.id, digest: value.digest };
      return Promise.resolve();
    }),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue('01J8ZQK7V0A2M4N6P8R0T2W4Z9'),
  };
  const searchIndexTasks = { append: vi.fn().mockResolvedValue(undefined) };
  const verifier = { verify: vi.fn().mockResolvedValue({
    contentVerified: true, questionBankVerified: true,
  }) };
  const searcher = { search: vi.fn().mockResolvedValue({
    items: [{
      courseVersionId: 'course-001',
      revision: 1,
      snippetText: '企业信息安全基础',
      highlights: [{ start: 2, end: 6 }],
      scoreBps: 9_000,
      indexedAt: NOW.toISOString(),
    }],
    nextCursor: null,
  }) };
  const onboarding = {
    get: vi.fn().mockResolvedValue({ id: 'onboarding-001', version: 4 }),
    recordTaskEvidence: vi.fn().mockResolvedValue({ onboarding: { id: 'onboarding-001', version: 5 } }),
  };
  const profiles = {
    resolveActive: vi.fn().mockResolvedValue({
      tenantId: 'tenant-001', actorId: 'employee-actor', employeeId: 'employee-001', status: 'active',
      roleCodes: [], scopes: [], departmentIds: ['department-001'], version: 1,
    }),
  };
  const employments = {
    findOpenByEmployeeId: vi.fn().mockResolvedValue({
      id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
      employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
      status: 'active', effectiveFrom: '2026-01-01', effectiveTo: null, version: 1,
    }),
  };
  const employees = {
    findById: vi.fn().mockResolvedValue({
      id: 'employee-001', tenantId: 'tenant-001', status: 'active',
      departmentIds: ['department-001'], primaryDepartmentId: 'department-001',
      positionIds: ['position-001'], version: 1,
    }),
  };
  const idempotency = { execute: vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  ) };
  const service = new KnowledgeApplicationService(
    idempotency as unknown as IdempotencyService,
    context,
    courses as unknown as CourseVersionRepository,
    assignments as unknown as TrainingAssignmentRepository,
    attempts as unknown as ExamAttemptRepository,
    evidence as unknown as KnowledgeEvidenceRepository,
    outbox as unknown as KnowledgeOutboxWriter,
    searchIndexTasks as unknown as KnowledgeSearchIndexTaskWriter,
    verifier,
    searcher,
    onboarding as unknown as OnboardingApplicationService,
    profiles as unknown as AccessProfileRepository,
    employments as unknown as EmploymentRepository,
    employees as unknown as EmployeeRepository,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'knowledge-worker', actorType: 'service' as const, tenantId: 'tenant-001',
      roleCodes: [], departmentIds: [], traceId: 'trace-001',
      scopes: [
        'erp:knowledge:course:create', 'erp:knowledge:course:publish',
        'erp:knowledge:course:read',
        'erp:knowledge:assignment:create', 'erp:knowledge:assignment:read',
        'erp:knowledge:search',
        'erp:knowledge:assignment:complete',
        'erp:integration:knowledge:progress', 'erp:knowledge:onboarding:attest',
      ],
    },
  };
  return {
    service, context, trusted, courses, assignments, attempts, evidence,
    outbox, searchIndexTasks, verifier, searcher, onboarding, profiles, idempotency,
    employments, employees,
    get assignment() { return assignment; },
    get attempt() { return attempt; },
  };
}

function employeeTrusted(store: ReturnType<typeof fixture>) {
  return {
    tenant: store.trusted.tenant,
    actor: {
      ...store.trusted.actor,
      actorId: 'employee-actor',
      actorType: 'user' as const,
    },
  };
}

describe('KnowledgeApplicationService', () => {
  it('创建、读取课程并保持响应最小化', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () => store.service.createCourse(
      'knowledge-create-001',
      {
        courseCode: 'PRIVACY',
        revision: 1,
        title: ' 隐私保护 ',
        contentRef: 'content-privacy-001',
      },
    ));

    expect(result.course).toMatchObject({
      courseCode: 'PRIVACY',
      title: '隐私保护',
      status: 'draft',
      version: 1,
      examRequired: false,
    });
    expect(result.course).not.toHaveProperty('contentRef');
    expect(store.courses.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', courseCode: 'PRIVACY' }),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.course.created' }),
      SESSION,
    );

    await expect(store.context.run(store.trusted, () =>
      store.service.getCourse('course-001'))).resolves.toMatchObject({
      id: 'course-001',
      courseCode: 'SECURITY',
    });
  });

  it('课程与任务不存在时失败关闭', async () => {
    const store = fixture();
    store.courses.findById.mockResolvedValueOnce(null);
    await expect(store.context.run(store.trusted, () =>
      store.service.getCourse('course-missing'))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_COURSE_NOT_FOUND' },
    });

    store.assignments.findById.mockResolvedValueOnce(null);
    await expect(store.context.run(store.trusted, () =>
      store.service.getAssignment('assignment-missing'))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ASSIGNMENT_NOT_FOUND' },
    });
  });

  it('分配课程并支持任务单项与列表读取', async () => {
    const store = fixture();
    const created = await store.context.run(store.trusted, () => store.service.assignCourse(
      'onboarding-001',
      'knowledge-assign-001',
      { courseVersionId: 'course-001', mandatory: false, dueDate: '2026-09-30' },
    ));

    expect(created.assignment).toMatchObject({
      onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-001',
      mandatory: false,
      examRequired: true,
      status: 'assigned',
    });
    expect(store.evidence.findAttestation).not.toHaveBeenCalled();
    expect(store.assignments.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', mandatory: false }),
      SESSION,
    );
    await expect(store.context.run(store.trusted, () =>
      store.service.getAssignment('assignment-001'))).resolves.toMatchObject({
      id: 'assignment-001',
    });
    await expect(store.context.run(store.trusted, () =>
      store.service.listOnboardingAssignments('onboarding-001'))).resolves.toMatchObject({
      items: [{ id: 'assignment-001' }],
    });
  });

  it('培训证明形成后拒绝追加必修任务', async () => {
    const store = fixture();
    store.evidence.findAttestation.mockResolvedValueOnce({
      id: 'attestation-001',
      digest: 'c'.repeat(43),
    });

    await expect(store.context.run(store.trusted, () => store.service.assignCourse(
      'onboarding-001',
      'knowledge-assign-attested',
      { courseVersionId: 'course-001', mandatory: true, dueDate: '2026-09-30' },
    ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ONBOARDING_ALREADY_ATTESTED' },
    });
    expect(store.assignments.insert).not.toHaveBeenCalled();
  });

  it('拒绝分配未发布课程并将领域校验映射为请求错误', async () => {
    const draft = createCourseVersion({
      id: 'course-001',
      tenantId: 'tenant-001',
      courseCode: 'SECURITY',
      revision: 1,
      title: '安全培训',
      contentRef: 'content-001',
    }, NOW);
    const store = fixture({ course: draft });

    await expect(store.context.run(store.trusted, () => store.service.assignCourse(
      'onboarding-001',
      'knowledge-assign-draft',
      { courseVersionId: 'course-001', mandatory: false, dueDate: '2026-09-30' },
    ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_COURSE_NOT_PUBLISHED' },
    });
  });

  it('写冲突、唯一冲突与跨租户领域错误使用稳定状态码', async () => {
    const writeConflictStore = fixture();
    writeConflictStore.courses.replace.mockRejectedValueOnce(new KnowledgeWriteConflictError());
    await expect(writeConflictStore.context.run(writeConflictStore.trusted, () =>
      writeConflictStore.service.retireCourse(
        'course-001',
        2,
        'knowledge-retire-conflict',
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_VERSION_CONFLICT' },
    });

    const duplicateStore = fixture();
    duplicateStore.courses.insert.mockRejectedValueOnce({ code: 11_000 });
    await expect(duplicateStore.context.run(duplicateStore.trusted, () =>
      duplicateStore.service.createCourse('knowledge-create-duplicate', {
        courseCode: 'PRIVACY',
        revision: 1,
        title: '隐私保护',
        contentRef: 'content-privacy-001',
      }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_UNIQUE_CONFLICT' },
    });

    const crossTenantStore = fixture({
      course: { ...publishedCourse(), tenantId: 'tenant-other' },
    });
    await expect(crossTenantStore.context.run(crossTenantStore.trusted, () =>
      crossTenantStore.service.retireCourse(
        'course-001',
        2,
        'knowledge-retire-cross-tenant',
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_CROSS_TENANT' },
    });
  });

  it('缺少业务权限时在访问仓储前拒绝请求', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, scopes: [] },
    };

    await expect(store.context.run(trusted, () =>
      store.service.getCourse('course-001'))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_SCOPE_REQUIRED' },
    });
    expect(store.courses.findById).not.toHaveBeenCalled();
  });

  it('本人任务只从可信主体映射到员工、当前任职与入职实例', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, actorId: 'employee-actor', actorType: 'user' as const },
    };
    const result = await store.context.run(trusted, () => store.service.listMyAssignments());
    expect(store.profiles.resolveActive).toHaveBeenCalledWith('tenant-001', 'employee-actor');
    expect(store.employments.findOpenByEmployeeId).toHaveBeenCalledWith('employee-001');
    expect(result.items[0]).toMatchObject({
      id: 'assignment-001', course: { title: '安全培训' }, mandatory: true, progressBps: 10_000,
    });
    expect(result.items[0]).not.toHaveProperty('onboardingInstanceId');
    expect(JSON.stringify(result)).not.toContain('content-001');
    expect(JSON.stringify(result)).not.toContain('bank-001');
  });

  it('本人任务拒绝服务主体和缺失员工主数据映射', async () => {
    const store = fixture();
    await expect(store.context.run(store.trusted, () => store.service.listMyAssignments()))
      .rejects.toMatchObject({ response: { code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED' } });
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, actorId: 'employee-actor', actorType: 'user' as const },
    };
    store.profiles.resolveActive.mockResolvedValueOnce(null);
    await expect(store.context.run(trusted, () => store.service.listMyAssignments()))
      .rejects.toMatchObject({ response: { code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED' } });
  });

  it('本人任务拒绝失效任职、员工主数据与缺失课程引用', async () => {
    const invalidEmployment = fixture();
    invalidEmployment.employments.findOpenByEmployeeId.mockResolvedValueOnce(null);
    await expect(invalidEmployment.context.run(employeeTrusted(invalidEmployment), () =>
      invalidEmployment.service.listMyAssignments())).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED' },
    });

    const invalidEmployee = fixture();
    invalidEmployee.employees.findById.mockResolvedValueOnce(null);
    await expect(invalidEmployee.context.run(employeeTrusted(invalidEmployee), () =>
      invalidEmployee.service.listMyAssignments())).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED' },
    });

    const missingCourse = fixture();
    missingCourse.courses.findByIds.mockResolvedValueOnce([]);
    await expect(missingCourse.context.run(employeeTrusted(missingCourse), () =>
      missingCourse.service.listMyAssignments())).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_COURSE_NOT_FOUND' },
    });
  });

  it('本人任务按到期日和任务编号稳定排序', async () => {
    const store = fixture();
    const later = createTrainingAssignment({
      id: 'assignment-002',
      tenantId: 'tenant-001',
      onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-001',
      mandatory: false,
      examRequired: true,
      dueDate: '2026-09-30',
      coursePublished: true,
    }, NOW);
    const sameDateLaterId = { ...store.assignment, id: 'assignment-003' };
    store.assignments.findByOnboarding.mockResolvedValueOnce([
      later,
      sameDateLaterId,
      store.assignment,
    ]);

    const result = await store.context.run(employeeTrusted(store), () =>
      store.service.listMyAssignments());
    expect(result.items.map((item) => item.id)).toEqual([
      'assignment-001',
      'assignment-003',
      'assignment-002',
    ]);
  });

  it('本人全文检索只传可信员工授权投影并用 ERP 课程二次授权', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, actorId: 'employee-actor', actorType: 'user' as const },
    };
    const result = await store.context.run(trusted, () => store.service.searchMyKnowledge({
      query: '  信息   安全  ',
      limit: 10,
    }));
    expect(store.searcher.search).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      departmentIds: ['department-001'],
      positionIds: ['position-001'],
      allowedCourseVersionIds: ['course-001'],
      queryText: '信息 安全',
      cursor: null,
      limit: 10,
    }));
    const searchInput = store.searcher.search.mock.calls[0]?.[0] as
      { readonly authorizationDigest?: unknown } | undefined;
    expect(searchInput?.authorizationDigest).toEqual(expect.any(String));
    expect(searchInput?.authorizationDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result).toMatchObject({
      items: [{
        course: { id: 'course-001', title: '安全培训' },
        snippetText: '企业信息安全基础',
      }],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/content-001|bank-001/u);
  });

  it('本人全文检索拒绝部门快照错位和网关课程版本错位', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, actorId: 'employee-actor', actorType: 'user' as const },
    };
    store.employees.findById.mockResolvedValueOnce({
      id: 'employee-001', tenantId: 'tenant-001', status: 'active',
      departmentIds: ['department-other'], primaryDepartmentId: 'department-other',
      positionIds: [], version: 2,
    });
    await expect(store.context.run(trusted, () => store.service.searchMyKnowledge({
      query: '信息安全',
    }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_EMPLOYEE_CONTEXT_REQUIRED' },
    });
    store.searcher.search.mockResolvedValueOnce({
      items: [{
        courseVersionId: 'course-001',
        revision: 2,
        snippetText: '不匹配版本',
        highlights: [],
        scoreBps: 8_000,
        indexedAt: NOW.toISOString(),
      }],
      nextCursor: null,
    });
    await expect(store.context.run(trusted, () => store.service.searchMyKnowledge({
      query: '信息安全',
    }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_SEARCH_AUTHORIZATION_MISMATCH' },
    });
  });

  it('本人全文检索拒绝早于当前课程发布状态的索引片段', async () => {
    const store = fixture();
    const trusted = {
      tenant: store.trusted.tenant,
      actor: { ...store.trusted.actor, actorId: 'employee-actor', actorType: 'user' as const },
    };
    store.searcher.search.mockResolvedValueOnce({
      items: [{
        courseVersionId: 'course-001',
        revision: 1,
        snippetText: '过期索引片段',
        highlights: [],
        scoreBps: 8_000,
        indexedAt: '2026-07-20T23:59:59.000Z',
      }],
      nextCursor: null,
    });

    await expect(store.context.run(trusted, () => store.service.searchMyKnowledge({
      query: '信息安全',
    }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_SEARCH_INDEX_FRESHNESS_INVALID' },
    });
  });

  it.each([
    [{ query: 'a' }, 'KNOWLEDGE_SEARCH_QUERY_INVALID'],
    [{ query: '信息!' }, 'KNOWLEDGE_SEARCH_QUERY_INVALID'],
    [{ query: '信'.repeat(129) }, 'KNOWLEDGE_SEARCH_QUERY_INVALID'],
    [{ query: '信息安全', cursor: 'short' }, 'KNOWLEDGE_SEARCH_CURSOR_INVALID'],
    [{ query: '信息安全', limit: 0 }, 'KNOWLEDGE_SEARCH_LIMIT_INVALID'],
    [{ query: '信息安全', limit: 21 }, 'KNOWLEDGE_SEARCH_LIMIT_INVALID'],
    [{ query: '信息安全', limit: 1.5 }, 'KNOWLEDGE_SEARCH_LIMIT_INVALID'],
  ])('本人全文检索拒绝非法查询参数 %#', async (input, code) => {
    const store = fixture();
    await expect(store.context.run(employeeTrusted(store), () =>
      store.service.searchMyKnowledge(input))).rejects.toMatchObject({
      response: { code },
    });
    expect(store.searcher.search).not.toHaveBeenCalled();
  });

  it('没有当前可发布课程时返回空结果且不调用搜索网关', async () => {
    const store = fixture();
    store.courses.findSearchEligible.mockResolvedValueOnce([]);

    await expect(store.context.run(employeeTrusted(store), () =>
      store.service.searchMyKnowledge({
        query: '信息安全',
        cursor: 'abcdefghijklmnop',
        limit: 20,
      }))).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.searcher.search).not.toHaveBeenCalled();
  });

  it('本人全文检索拒绝无效或超前的索引时间', async () => {
    const store = fixture();
    store.searcher.search.mockResolvedValueOnce({
      items: [{
        courseVersionId: 'course-001',
        revision: 1,
        snippetText: '无效时间',
        highlights: [],
        scoreBps: 8_000,
        indexedAt: 'not-a-date',
      }],
      nextCursor: null,
    });
    await expect(store.context.run(employeeTrusted(store), () =>
      store.service.searchMyKnowledge({ query: '信息安全' }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_SEARCH_INDEX_FRESHNESS_INVALID' },
    });

    store.searcher.search.mockResolvedValueOnce({
      items: [{
        courseVersionId: 'course-001',
        revision: 1,
        snippetText: '超前时间',
        highlights: [],
        scoreBps: 8_000,
        indexedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }],
      nextCursor: null,
    });
    await expect(store.context.run(employeeTrusted(store), () =>
      store.service.searchMyKnowledge({ query: '信息安全' }))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_SEARCH_INDEX_FRESHNESS_INVALID' },
    });
  });

  it('课程发布证明只来自校验端口，响应不暴露内容与题库引用', async () => {
    const draft = createCourseVersion({
      id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
      title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
    }, NOW);
    const store = fixture({ course: draft });
    const result = await store.context.run(store.trusted, () =>
      store.service.publishCourse('course-001', 1, 'knowledge-publish-001'),
    );
    expect(store.verifier.verify).toHaveBeenCalledWith(draft);
    expect(store.courses.findById).toHaveBeenCalledOnce();
    expect(store.courses.findById).toHaveBeenCalledWith('course-001', SESSION);
    expect(result.course.status).toBe('published');
    expect(result.course).not.toHaveProperty('questionBankRef');
    expect(result.course).not.toHaveProperty('contentRef');
    expect(store.searchIndexTasks.append).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Z9',
      expect.objectContaining({ id: 'course-001', status: 'published' }),
      'upsert',
      SESSION,
    );
  });

  it('课程发布幂等重放不再依赖内容校验器或数据库写入', async () => {
    const store = fixture();
    const replay = {
      course: {
        id: 'course-001',
        courseCode: 'SECURITY',
        revision: 1,
        title: '安全培训',
        examRequired: true,
        passingScoreBps: 8_000,
        questionMode: 'objective' as const,
        timeLimitMinutes: 60,
        maxAttempts: 3,
        gradingPolicyVersion: 'objective-auto-v1',
        passingRule: 'score_threshold' as const,
        gradingSlaMinutes: 5,
        manualReviewSlaMinutes: 1_440,
        manualReviewRequired: false,
        status: 'published' as const,
        version: 2,
      },
    };
    store.idempotency.execute.mockResolvedValueOnce(replay);
    store.verifier.verify.mockRejectedValueOnce(new Error('校验器不可用'));

    await expect(store.context.run(store.trusted, () =>
      store.service.publishCourse('course-001', 1, 'knowledge-publish-replay'),
    )).resolves.toEqual(replay);

    expect(store.verifier.verify).not.toHaveBeenCalled();
    expect(store.courses.findById).not.toHaveBeenCalled();
    expect(store.courses.replace).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
    expect(store.searchIndexTasks.append).not.toHaveBeenCalled();
  });

  it('Mongo 事务自动重试相同课程快照时只调用一次外部校验器', async () => {
    const draft = createCourseVersion({
      id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
      title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
    }, NOW);
    const store = fixture({ course: draft });
    /** 模拟第一次事务尝试回滚：第二次回调仍读取相同持久化快照。 */
    store.courses.findById.mockResolvedValue(draft);
    store.idempotency.execute.mockImplementationOnce(async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => {
      await handler(SESSION);
      return handler(SESSION);
    });

    await expect(store.context.run(store.trusted, () =>
      store.service.publishCourse('course-001', 1, 'knowledge-publish-retry'),
    )).resolves.toMatchObject({ course: { status: 'published', version: 2 } });

    expect(store.courses.findById).toHaveBeenCalledTimes(2);
    expect(store.verifier.verify).toHaveBeenCalledOnce();
    expect(store.verifier.verify).toHaveBeenCalledWith(draft);
    expect(store.courses.replace).toHaveBeenCalledTimes(2);
  });

  it('Mongo 事务重试读取到不同课程事实时重新校验并拒绝旧版本写入', async () => {
    const draft = createCourseVersion({
      id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
      title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
    }, NOW);
    const changed = Object.freeze({
      ...draft,
      contentRef: 'content-002',
      version: 2,
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const store = fixture({ course: draft });
    store.courses.findById
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(changed);
    store.idempotency.execute.mockImplementationOnce(async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => {
      await handler(SESSION);
      return handler(SESSION);
    });

    await expect(store.context.run(store.trusted, () =>
      store.service.publishCourse('course-001', 1, 'knowledge-publish-retry-changed'),
    )).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_VERSION_CONFLICT' },
    });

    expect(store.verifier.verify).toHaveBeenCalledTimes(2);
    expect(store.verifier.verify).toHaveBeenNthCalledWith(1, draft);
    expect(store.verifier.verify).toHaveBeenNthCalledWith(2, changed);
    expect(store.courses.replace).toHaveBeenCalledOnce();
  });

  it('课程发布校验失败时不形成课程终态、事件或索引任务', async () => {
    const draft = createCourseVersion({
      id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
      title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
    }, NOW);
    const store = fixture({ course: draft });
    store.verifier.verify.mockRejectedValueOnce(new Error('校验器不可用'));

    await expect(store.context.run(store.trusted, () =>
      store.service.publishCourse('course-001', 1, 'knowledge-publish-failed'),
    )).rejects.toThrow('校验器不可用');

    expect(store.courses.findById).toHaveBeenCalledWith('course-001', SESSION);
    expect(store.courses.replace).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
    expect(store.searchIndexTasks.append).not.toHaveBeenCalled();
  });

  it('课程下架在同一事务写删除任务且不直接调用搜索网关', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () =>
      store.service.retireCourse('course-001', 2, 'knowledge-retire-001'),
    );
    expect(result.course.status).toBe('retired');
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.course.retired' }),
      SESSION,
    );
    expect(store.searchIndexTasks.append).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Z9',
      expect.objectContaining({ id: 'course-001', status: 'retired' }),
      'delete',
      SESSION,
    );
    expect(store.searcher.search).not.toHaveBeenCalled();
  });

  it('集成进度首次写入形成任务、证据与事件的同一事务终态', async () => {
    const assigned = createTrainingAssignment({
      id: 'assignment-001',
      tenantId: 'tenant-001',
      onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-001',
      mandatory: true,
      examRequired: true,
      dueDate: '2026-08-31',
      coursePublished: true,
    }, NOW);
    const store = fixture({ assignment: assigned });
    const input = {
      source: 'trusted-lms',
      sourceEventId: 'progress-001',
      progressBps: 4_000,
      occurredAt: '2026-07-22T00:00:00.000Z',
    };

    const result = await store.context.run(store.trusted, () =>
      store.service.recordProgressForIntegration(
        'assignment-001',
        1,
        'knowledge-progress-001',
        input,
      ));
    expect(result.assignment).toMatchObject({
      status: 'in_progress',
      progressBps: 4_000,
      version: 2,
    });
    expect(store.assignments.replace).toHaveBeenCalledWith(
      expect.objectContaining({ progressBps: 4_000 }),
      1,
      SESSION,
    );
    expect(store.evidence.appendProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        assignmentId: 'assignment-001',
        ...input,
      }),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.assignment.progressed' }),
      SESSION,
    );
  });

  it('集成进度对相同源事件重放，对事实错配拒绝', async () => {
    const store = fixture();
    store.evidence.findProgressEvent.mockResolvedValue({
      assignmentId: 'assignment-001',
      progressBps: 10_000,
    });
    const input = {
      source: 'trusted-lms',
      sourceEventId: 'progress-001',
      progressBps: 10_000,
      occurredAt: '2026-07-22T00:00:00.000Z',
    };

    await expect(store.context.run(store.trusted, () =>
      store.service.recordProgressForIntegration(
        'assignment-001',
        2,
        'knowledge-progress-replay',
        input,
      ))).resolves.toMatchObject({
      assignment: { id: 'assignment-001', progressBps: 10_000 },
    });
    expect(store.assignments.replace).not.toHaveBeenCalled();

    store.evidence.findProgressEvent.mockResolvedValueOnce({
      assignmentId: 'assignment-other',
      progressBps: 10_000,
    });
    await expect(store.context.run(store.trusted, () =>
      store.service.recordProgressForIntegration(
        'assignment-001',
        2,
        'knowledge-progress-reused',
        input,
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_PROGRESS_EVENT_REUSED' },
    });
  });

  it.each([
    [
      { source: '!invalid', sourceEventId: 'progress-001', progressBps: 100, occurredAt: NOW.toISOString() },
      'KNOWLEDGE_PROGRESS_SOURCE_INVALID',
    ],
    [
      { source: 'trusted-lms', sourceEventId: 'progress-002', progressBps: 100, occurredAt: 'invalid' },
      'KNOWLEDGE_DATE_INVALID',
    ],
    [
      { source: 'trusted-lms', sourceEventId: 'progress-003', progressBps: 100, occurredAt: '2026-07-20T00:00:00.000Z' },
      'KNOWLEDGE_PROGRESS_TIME_INVALID',
    ],
    [
      { source: 'trusted-lms', sourceEventId: 'progress-004', progressBps: 100, occurredAt: '2999-01-01T00:00:00.000Z' },
      'KNOWLEDGE_PROGRESS_TIME_INVALID',
    ],
  ])('集成进度拒绝非法来源与时间 %#', async (input, code) => {
    const assigned = createTrainingAssignment({
      id: 'assignment-001',
      tenantId: 'tenant-001',
      onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-001',
      mandatory: true,
      examRequired: true,
      dueDate: '2026-08-31',
      coursePublished: true,
    }, NOW);
    const store = fixture({ assignment: assigned });

    await expect(store.context.run(store.trusted, () =>
      store.service.recordProgressForIntegration(
        'assignment-001',
        1,
        `knowledge-progress-invalid-${code}`,
        input,
      ))).rejects.toMatchObject({ response: { code } });
    expect(store.assignments.replace).not.toHaveBeenCalled();
  });

  it('考试任务缺少已通过尝试时拒绝完成', async () => {
    const store = fixture();
    await expect(store.context.run(store.trusted, () =>
      store.service.completeAssignment(
        'assignment-001',
        2,
        'knowledge-complete-no-attempt',
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_PASSED_EXAM_REQUIRED' },
    });
  });

  it('免试非必修任务完成后不生成入职培训证明', async () => {
    const store = fixture({ assignment: completedContentOnlyAssignment(false) });
    const result = await store.context.run(store.trusted, () =>
      store.service.completeAssignment(
        'assignment-001',
        2,
        'knowledge-complete-content-only',
      ));

    expect(result.assignment).toMatchObject({
      status: 'completed',
      examRequired: false,
      mandatory: false,
    });
    expect(store.attempts.findById).not.toHaveBeenCalled();
    expect(store.evidence.insertAttestation).not.toHaveBeenCalled();
    expect(store.onboarding.recordTaskEvidence).not.toHaveBeenCalled();
  });

  it('已形成培训证明与当前必修事实不一致时拒绝覆盖', async () => {
    const store = fixture({ assignment: completedContentOnlyAssignment(true) });
    store.evidence.findAttestation.mockResolvedValueOnce({
      id: 'attestation-001',
      digest: 'd'.repeat(43),
    });

    await expect(store.context.run(store.trusted, () =>
      store.service.completeAssignment(
        'assignment-001',
        2,
        'knowledge-complete-attestation-changed',
      ))).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ONBOARDING_ATTESTATION_CHANGED' },
    });
    expect(store.onboarding.recordTaskEvidence).not.toHaveBeenCalled();
  });

  it('全部必修完成后生成聚合证明并回填 Onboarding', async () => {
    const passed: ExamAttempt = {
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      questionMode: 'objective', gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold', manualReviewEvidenceId: null,
      submissionReason: 'learner',
      scoreBps: 8_500, passed: true, gradedAt: NOW.toISOString(),
    };
    const store = fixture({ attempt: passed });
    const result = await store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 2, 'knowledge-complete-001', 'attempt-001',
    ));
    expect(result.assignment.status).toBe('completed');
    expect(store.evidence.insertAttestation).toHaveBeenCalledOnce();
    expect(store.onboarding.recordTaskEvidence).toHaveBeenCalledWith(
      'onboarding-001', 4, expect.stringMatching(/^knowledge:/),
      expect.objectContaining({ taskCode: 'mandatory_training_completed' }),
    );
  });

  it('Onboarding 回填中断后可用不同根幂等键续跑而不重复完成任务', async () => {
    const passed: ExamAttempt = {
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      questionMode: 'objective', gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold', manualReviewEvidenceId: null,
      submissionReason: 'learner',
      scoreBps: 8_500, passed: true, gradedAt: NOW.toISOString(),
    };
    const store = fixture({ attempt: passed });
    store.onboarding.recordTaskEvidence.mockRejectedValueOnce(new Error('暂时失败'));
    await expect(store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 2, 'knowledge-complete-001', 'attempt-001',
    ))).rejects.toThrow('暂时失败');
    expect(store.assignment.status).toBe('completed');
    await store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 3, 'knowledge-complete-retry', 'attempt-001',
    ));
    expect(store.onboarding.recordTaskEvidence).toHaveBeenCalledTimes(2);
    expect(store.evidence.insertAttestation).toHaveBeenCalledTimes(1);
  });

  it('已完成任务的续跑仍校验版本和考试引用', async () => {
    const passed: ExamAttempt = {
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      questionMode: 'objective', gradingPolicyVersion: 'objective-auto-v1',
      passingRule: 'score_threshold', manualReviewEvidenceId: null,
      submissionReason: 'learner',
      scoreBps: 8_500, passed: true, gradedAt: NOW.toISOString(),
    };
    const store = fixture({ attempt: passed });
    await store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 2, 'knowledge-complete-003', 'attempt-001',
    ));
    await expect(store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 2, 'knowledge-complete-004', 'attempt-001',
    ))).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_VERSION_CONFLICT',
    } });
    await expect(store.context.run(store.trusted, () => store.service.completeAssignment(
      'assignment-001', 3, 'knowledge-complete-005', 'attempt-other',
    ))).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_PASSED_EXAM_MISMATCH',
    } });
  });
});
