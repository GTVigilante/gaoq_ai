import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OnboardingApplicationService } from '../../onboarding/application/onboarding-application.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { EmploymentRepository } from '../../org/persistence/org.repositories.js';
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
import type {
  CourseVersionRepository,
  ExamAttemptRepository,
  KnowledgeEvidenceRepository,
  TrainingAssignmentRepository,
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
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const grader = { grade: vi.fn().mockResolvedValue({
    scoreBps: 8_500, questionBankDigest: 'a'.repeat(43),
    questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
  }) };
  const verifier = { verify: vi.fn().mockResolvedValue({
    contentVerified: true, questionBankVerified: true,
  }) };
  const onboarding = {
    get: vi.fn().mockResolvedValue({ id: 'onboarding-001', version: 4 }),
    recordTaskEvidence: vi.fn().mockResolvedValue({ onboarding: { id: 'onboarding-001', version: 5 } }),
  };
  const profiles = {
    resolveActive: vi.fn().mockResolvedValue({
      tenantId: 'tenant-001', actorId: 'employee-actor', employeeId: 'employee-001', status: 'active',
      roleCodes: [], scopes: [], departmentIds: [], version: 1,
    }),
  };
  const employments = {
    findOpenByEmployeeId: vi.fn().mockResolvedValue({
      id: 'employment-001', employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
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
    grader,
    verifier,
    onboarding as unknown as OnboardingApplicationService,
    profiles as unknown as AccessProfileRepository,
    employments as unknown as EmploymentRepository,
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
        'erp:knowledge:exam:grade', 'erp:knowledge:assignment:complete',
        'erp:integration:knowledge:progress', 'erp:knowledge:onboarding:attest',
      ],
    },
  };
  return {
    service, context, trusted, courses, assignments, attempts, evidence,
    outbox, grader, verifier, onboarding, profiles, employments,
    get assignment() { return assignment; },
    get attempt() { return attempt; },
  };
}

describe('KnowledgeApplicationService', () => {
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
    expect(result.course.status).toBe('published');
    expect(result.course).not.toHaveProperty('questionBankRef');
    expect(result.course).not.toHaveProperty('contentRef');
  });

  it('考试只接受评分端口结果，摘要不包含提交或题库数据', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () =>
      store.service.gradeExam('assignment-001', 'knowledge-grade-001', 'submission-001'),
    );
    expect(store.grader.grade).toHaveBeenCalledOnce();
    expect(result.attempt).toMatchObject({ scoreBps: 8_500, passed: true });
    expect(result.attempt).not.toHaveProperty('submissionRef');
    expect(result.attempt).not.toHaveProperty('questionSetDigest');
  });

  it('终态任务拒绝继续考试', async () => {
    const passed: ExamAttempt = {
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      scoreBps: 8_500, passed: true, gradedAt: NOW.toISOString(),
    };
    const first = fixture({ attempt: passed });
    await first.context.run(first.trusted, () => first.service.completeAssignment(
      'assignment-001', 2, 'knowledge-complete-002', 'attempt-001',
    ));
    await expect(first.context.run(first.trusted, () => first.service.gradeExam(
      'assignment-001', 'knowledge-grade-002', 'submission-002',
    ))).rejects.toMatchObject({ response: {
      code: 'KNOWLEDGE_ASSIGNMENT_TERMINAL',
    } });
    expect(first.grader.grade).not.toHaveBeenCalled();
  });

  it('全部必修完成后生成聚合证明并回填 Onboarding', async () => {
    const passed: ExamAttempt = {
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
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
