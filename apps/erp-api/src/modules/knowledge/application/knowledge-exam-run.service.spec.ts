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
  type KnowledgeExamRun,
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

function fixture(options?: {
  readonly onboardingInstanceId?: string;
  readonly initialRun?: KnowledgeExamRun;
}) {
  const context = new TenantContextService();
  const onboardingInstanceId = options?.onboardingInstanceId ?? 'onboarding-001';
  const assignment = createTrainingAssignment({
    id: 'assignment-001',
    tenantId: 'tenant-001',
    onboardingInstanceId,
    courseVersionId: 'course-001',
    mandatory: true,
    examRequired: true,
    dueDate: '2026-08-31',
    coursePublished: true,
  }, NOW);
  const course = publishCourseVersion(createCourseVersion({
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
  }, NOW);
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
  const service = new KnowledgeExamRunService(
    idempotency as unknown as IdempotencyService,
    context,
    {
      findById: vi.fn().mockResolvedValue(course),
    } as unknown as CourseVersionRepository,
    {
      findById: vi.fn().mockResolvedValue(assignment),
    } as unknown as TrainingAssignmentRepository,
    runs as unknown as KnowledgeExamRunRepository,
    {
      append: vi.fn().mockResolvedValue('event-001'),
    } as unknown as KnowledgeOutboxWriter,
    {
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
    } as unknown as AccessProfileRepository,
    {
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
    } as unknown as EmploymentRepository,
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
  return { context, trusted, service, runs };
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
    submissionRef: '01J8ZQK7V0A2M4N6P8R0T2W4B2',
    questionSetDigest: 'b'.repeat(43),
    startedAt: NOW.toISOString(),
    deadlineAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    submittedAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    submissionReason: 'learner',
    nextActionAt: NOW.toISOString(),
    version: 3,
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
