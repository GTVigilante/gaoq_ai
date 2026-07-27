import type { ClientSession } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import type {
  CandidateApplication,
  RecruitmentInterview,
  RecruitmentPosition,
} from '../domain/index.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  RecruitmentWriteConflictError,
  type CandidateApplicationRepository,
  type RecruitmentInterviewFeedbackRepository,
  type RecruitmentInterviewRepository,
  type RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentInterviewService } from './recruitment-interview.service.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';
const SESSION = { id: 'session' } as unknown as ClientSession;
const TEST_NOW = new Date('2026-07-22T07:00:00.000Z');

const application: CandidateApplication = {
  id: APPLICATION_ID, tenantId: 'tenant-001', candidateId: 'candidate-001',
  positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8', consentEvidenceId: 'consent-001',
  sourceChannel: 'portal', stage: 'interview' as const, completedInterviewId: null,
  offerId: null, acceptanceEvidenceId: null, onboardingInstanceId: null, employmentId: null,
  version: 3, appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
  updatedAt: '2026-07-21T00:00:00.000Z',
};
const position: RecruitmentPosition = {
  id: application.positionId,
  tenantId: 'tenant-001',
  requisitionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
  title: '小红书经纪人',
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  location: '上海',
  headcount: 2,
  status: 'open',
  version: 2,
  publishedAt: '2026-07-20T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};
const interview: RecruitmentInterview = {
  id: INTERVIEW_ID, tenantId: 'tenant-001', applicationId: APPLICATION_ID,
  roundNumber: 1, mode: 'video' as const, startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z', timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001', 'employee-002'], location: 'https://meeting.example/secret',
  status: 'scheduled' as const, version: 1, completedAt: null, cancelledAt: null,
  createdBy: 'actor-hr', createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

function fixture(options?: {
  readonly actorType?: 'user' | 'service' | 'system_job';
  readonly employeeStatus?: 'active' | 'probation' | 'suspended' | 'terminated';
  readonly actorDepartments?: readonly string[];
  readonly scopes?: readonly string[];
  readonly feedbackIds?: readonly string[];
}) {
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string, _key: string, _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'actor-001', tenantId: 'tenant-001',
      actorType: options?.actorType ?? 'user' as const,
      roleCodes: [], scopes: options?.scopes ?? [],
      departmentIds: options?.actorDepartments ?? ['department-001'], traceId: 'trace-001',
    },
  };
  const context = {
    getRequired: vi.fn().mockReturnValue(trusted),
    getTenantRequired: vi.fn().mockReturnValue(trusted.tenant),
    getActorRequired: vi.fn().mockReturnValue(trusted.actor),
  };
  const profiles = { resolveActive: vi.fn().mockResolvedValue({ employeeId: 'employee-001' }) };
  const employees = { findById: vi.fn().mockImplementation((id: string) => Promise.resolve({
    id, tenantId: 'tenant-001', status: options?.employeeStatus ?? 'active',
  })) };
  const applications = { findById: vi.fn().mockResolvedValue(application) };
  const positions = { findById: vi.fn().mockResolvedValue(position) };
  const interviews = {
    findById: vi.fn().mockResolvedValue(interview),
    insert: vi.fn().mockResolvedValue(undefined),
    insertMigrated: vi.fn().mockResolvedValue(undefined),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const feedback = {
    append: vi.fn().mockResolvedValue(undefined),
    findByInterview: vi.fn().mockResolvedValue([]),
    findInterviewerIds: vi.fn().mockResolvedValue(
      options?.feedbackIds ?? ['employee-001', 'employee-002'],
    ),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentInterviewService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    profiles as unknown as AccessProfileRepository,
    employees as unknown as EmployeeRepository,
    applications as unknown as CandidateApplicationRepository,
    positions as unknown as RecruitmentPositionRepository,
    interviews as unknown as RecruitmentInterviewRepository,
    feedback as unknown as RecruitmentInterviewFeedbackRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return {
    service, execute, profiles, employees, applications, positions, interviews, feedback, outbox,
  };
}

const scheduleInput = {
  roundNumber: 1, mode: 'video' as const,
  startsAt: '2026-07-22T08:00:00.000Z', endsAt: '2026-07-22T09:00:00.000Z',
  timezone: 'Asia/Shanghai', interviewerIds: ['employee-001', 'employee-002'],
  location: 'https://meeting.example/secret',
};

const migrationInput = {
  targetId: null as string | null,
  applicationId: APPLICATION_ID,
  roundNumber: 1,
  mode: 'video' as const,
  startsAt: '2026-07-21T02:00:00.000Z',
  endsAt: '2026-07-21T03:00:00.000Z',
  timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001', 'employee-002'],
  location: 'https://meeting.example/migrated-secret',
  createdByEmployeeId: 'employee-hr',
  feedback: [
    {
      interviewerId: 'employee-001', recommendation: 'hire' as const, score: 4,
      notes: '技术能力符合要求', submittedAt: '2026-07-21T03:01:00.000Z',
    },
    {
      interviewerId: 'employee-002', recommendation: 'strong_hire' as const, score: 5,
      notes: '业务理解深入', submittedAt: '2026-07-21T03:02:00.000Z',
    },
  ],
  expectedStatus: 'completed' as const,
  expectedVersion: 4,
  completedAt: '2026-07-21T03:03:00.000Z',
  cancelledAt: null as string | null,
  createdAt: '2026-07-20T02:00:00.000Z',
  updatedAt: '2026-07-21T03:03:00.000Z',
  migrationEvidenceRef:
    'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4Y6/attachments/interview-001',
  evidenceChecksum: 'a'.repeat(43),
};

const migratedFeedback = [
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    ...migrationInput.feedback[0]!,
  },
  {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F2',
    ...migrationInput.feedback[1]!,
  },
];

const migratedInterview: RecruitmentInterview = {
  id: INTERVIEW_ID,
  tenantId: 'tenant-001',
  applicationId: APPLICATION_ID,
  roundNumber: migrationInput.roundNumber,
  mode: migrationInput.mode,
  startsAt: migrationInput.startsAt,
  endsAt: migrationInput.endsAt,
  timezone: migrationInput.timezone,
  interviewerIds: migrationInput.interviewerIds,
  location: migrationInput.location,
  status: migrationInput.expectedStatus,
  version: migrationInput.expectedVersion,
  completedAt: migrationInput.completedAt,
  cancelledAt: migrationInput.cancelledAt,
  createdBy: migrationInput.createdByEmployeeId,
  createdAt: migrationInput.createdAt,
  updatedAt: migrationInput.updatedAt,
};

describe('RecruitmentInterviewService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('排期在同一幂等事务内验证 ERP 有效员工、加密持久并写 Outbox', async () => {
    const store = fixture();
    const result = await store.service.schedule(
      APPLICATION_ID, 3, 'interview-schedule-key-001', scheduleInput,
    );
    expect(store.employees.findById).toHaveBeenCalledTimes(2);
    expect(store.employees.findById).toHaveBeenNthCalledWith(1, 'employee-001', SESSION);
    expect(store.interviews.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', applicationId: APPLICATION_ID, status: 'scheduled',
    }), SESSION);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.interview.scheduled', aggregateType: 'recruitment.interview',
    }), SESSION);
    expect(result.interview).not.toHaveProperty('location');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('meeting.example');
  });

  it('排期拒绝已停职或离职面试官', async () => {
    const store = fixture({ employeeStatus: 'suspended' });
    await expect(store.service.schedule(
      APPLICATION_ID, 3, 'interview-schedule-key-002', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEWER_INACTIVE' } });
    expect(store.interviews.insert).not.toHaveBeenCalled();
  });

  it('迁移面试只写最终密文聚合、评价与迁移事件', async () => {
    const store = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const result = await store.service.importInterviewFromMigration(
      'interview-migration-key-001',
      migrationInput,
    );
    expect(store.interviews.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', version: 4 }),
      expect.stringContaining('/attachments/interview-001'), 'a'.repeat(43), SESSION,
    );
    expect(store.feedback.append).toHaveBeenCalledTimes(2);
    expect(store.outbox.append).toHaveBeenCalledTimes(1);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.interview.migrated',
    }), SESSION);
    const migratedEvent = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly payload: { readonly feedbackCount: number };
    };
    expect(migratedEvent.payload).toMatchObject({ feedbackCount: 2 });
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('migrated-secret');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('技术能力符合要求');
    expect(result.interview).toMatchObject({ status: 'completed', version: 4 });
  });

  it('评价提交先将可信 actor 映射为 employeeId，响应和事件不泄漏评价', async () => {
    const store = fixture();
    const input = { recommendation: 'hire' as const, score: 4, notes: '候选人经验匹配' };
    const result = await store.service.submitFeedback(
      INTERVIEW_ID, 1, 'interview-feedback-key-001', input,
    );
    expect(store.profiles.resolveActive).toHaveBeenCalledWith('tenant-001', 'actor-001', SESSION);
    expect(store.feedback.append).toHaveBeenCalledWith(expect.objectContaining({
      interviewerId: 'employee-001', recommendation: 'hire', score: 4,
    }), SESSION);
    expect(store.interviews.replace).toHaveBeenCalledWith(expect.objectContaining({
      id: INTERVIEW_ID, status: 'scheduled', version: 2,
    }), 1, SESSION);
    expect(result.feedback).not.toHaveProperty('recommendation');
    expect(result.feedback).not.toHaveProperty('score');
    expect(result.feedback).not.toHaveProperty('notes');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('候选人经验匹配');
  });

  it('全部评价证据齐备后原子完成面试和 Outbox', async () => {
    const store = fixture();
    const result = await store.service.complete(INTERVIEW_ID, 1, 'interview-complete-key-001');
    expect(store.feedback.findInterviewerIds).toHaveBeenCalledWith(INTERVIEW_ID, SESSION);
    expect(store.interviews.replace).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', version: 2,
    }), 1, SESSION);
    const completed = store.interviews.replace.mock.calls[0]?.[0] as unknown as {
      readonly completedAt: unknown;
    };
    expect(typeof completed.completedAt).toBe('string');
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.interview.completed', version: 2,
    }), SESSION);
    expect(result.interview).toMatchObject({ status: 'completed', version: 2 });
  });

  it('读取允许本轮面试官，并拒绝无数据范围的其他员工', async () => {
    await expect(fixture({ actorDepartments: [] }).service.get(INTERVIEW_ID))
      .resolves.toMatchObject({ id: INTERVIEW_ID });
    const denied = fixture({ actorDepartments: [] });
    denied.profiles.resolveActive.mockResolvedValue({ employeeId: 'employee-003' });
    await expect(denied.service.get(INTERVIEW_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_READ_DENIED' } });
  });

  it('日历敏感投影只对 Integration Worker 专用 Scope 开放', async () => {
    const denied = fixture();
    await expect(denied.service.getCalendarProjectionForIntegration(INTERVIEW_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_CALENDAR_PROJECTION_DENIED' } });
    const spoofedUser = fixture({ scopes: ['erp:integration:calendar:deliver'] });
    await expect(spoofedUser.service.getCalendarProjectionForIntegration(INTERVIEW_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_CALENDAR_PROJECTION_DENIED' } });
    const allowed = fixture({
      actorType: 'system_job', scopes: ['erp:integration:calendar:deliver'],
    });
    const result = await allowed.service.getCalendarProjectionForIntegration(INTERVIEW_ID);
    expect(result).toMatchObject({
      interviewId: INTERVIEW_ID, location: 'https://meeting.example/secret', version: 1,
    });
    expect(result).not.toHaveProperty('candidateId');
  });

  it('排期对申请、职位和部门写范围采用失败关闭', async () => {
    const missingApplication = fixture();
    missingApplication.applications.findById.mockResolvedValueOnce(null);
    await expect(missingApplication.service.schedule(
      APPLICATION_ID, 3, 'schedule-application-missing', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_FOUND' } });

    const versionConflict = fixture();
    await expect(versionConflict.service.schedule(
      APPLICATION_ID, 2, 'schedule-version-conflict', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const invalidStage = fixture();
    invalidStage.applications.findById.mockResolvedValueOnce({ ...application, stage: 'screening' });
    await expect(invalidStage.service.schedule(
      APPLICATION_ID, 3, 'schedule-stage-invalid', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_INTERVIEWING' } });

    const missingPosition = fixture();
    missingPosition.positions.findById.mockResolvedValueOnce(null);
    await expect(missingPosition.service.schedule(
      APPLICATION_ID, 3, 'schedule-position-missing', scheduleInput,
    )).rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');

    const denied = fixture({ actorDepartments: [] });
    await expect(denied.service.schedule(
      APPLICATION_ID, 3, 'schedule-department-denied', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_WRITE_DENIED' } });
    expect(denied.interviews.insert).not.toHaveBeenCalled();
  });

  it('全局招聘写权限可跨部门排期，员工缺失仍被拒绝', async () => {
    const allowed = fixture({
      actorDepartments: [],
      scopes: ['erp:recruitment:management:write_all'],
    });
    const result = await allowed.service.schedule(
      APPLICATION_ID, 3, 'schedule-write-all', scheduleInput,
    );
    expect(typeof result.interview.id).toBe('string');

    const missingEmployee = fixture();
    missingEmployee.employees.findById.mockResolvedValueOnce(null);
    await expect(missingEmployee.service.schedule(
      APPLICATION_ID, 3, 'schedule-employee-missing', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEWER_INACTIVE' } });
  });

  it('排期校验日期、领域输入和唯一键错误契约', async () => {
    const invalidDate = fixture();
    await expect(invalidDate.service.schedule(
      APPLICATION_ID, 3, 'schedule-invalid-date',
      { ...scheduleInput, startsAt: 'invalid-date' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INVALID_DATE' } });

    const invalidTimezone = fixture();
    await expect(invalidTimezone.service.schedule(
      APPLICATION_ID, 3, 'schedule-invalid-timezone',
      { ...scheduleInput, timezone: 'Asia Shanghai' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_TIMEZONE_INVALID' } });

    const duplicate = fixture();
    duplicate.interviews.insert.mockRejectedValueOnce({ code: 11_000 });
    await expect(duplicate.service.schedule(
      APPLICATION_ID, 3, 'schedule-duplicate', scheduleInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_UNIQUE_CONFLICT' } });
  });

  it('迁移入口强制服务身份、双 Scope 与标准 WORM 证据', async () => {
    const deniedActor = fixture({
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(deniedActor.service.importInterviewFromMigration(
      'migration-actor-denied', migrationInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' } });

    const deniedScope = fixture({
      actorType: 'system_job',
      scopes: ['erp:migration:execute'],
    });
    await expect(deniedScope.service.importInterviewFromMigration(
      'migration-scope-denied', migrationInput,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' } });

    const invalidEvidence = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(invalidEvidence.service.importInterviewFromMigration(
      'migration-evidence-invalid',
      { ...migrationInput, evidenceChecksum: 'invalid' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_INTERVIEW_EVIDENCE_INVALID' },
    });
  });

  it('迁移拒绝非面试申请和无效员工引用', async () => {
    const invalidStage = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    invalidStage.applications.findById.mockResolvedValueOnce({
      ...application,
      stage: 'screening',
    });
    await expect(invalidStage.service.importInterviewFromMigration(
      'migration-stage-invalid', migrationInput,
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_INTERVIEW_APPLICATION_INVALID' },
    });

    const invalidEmployee = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    invalidEmployee.employees.findById.mockResolvedValueOnce(null);
    await expect(invalidEmployee.service.importInterviewFromMigration(
      'migration-employee-invalid', migrationInput,
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_INTERVIEW_EMPLOYEE_INVALID' },
    });

    const inactiveScheduledInterviewer = fixture({
      actorType: 'system_job',
      employeeStatus: 'suspended',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(inactiveScheduledInterviewer.service.importInterviewFromMigration(
      'migration-scheduled-interviewer-inactive',
      {
        ...migrationInput,
        feedback: [],
        expectedStatus: 'scheduled',
        expectedVersion: 1,
        completedAt: null,
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_INTERVIEW_EMPLOYEE_INVALID' },
    });
  });

  it('迁移既有面试按聚合、评价和证据精确幂等，任何漂移均拒绝覆盖', async () => {
    const replay = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    replay.interviews.findById.mockResolvedValueOnce(migratedInterview);
    replay.interviews.findMigrationEvidenceById.mockResolvedValueOnce({
      migrationEvidenceRef: migrationInput.migrationEvidenceRef,
      migrationEvidenceChecksum: migrationInput.evidenceChecksum,
    });
    replay.feedback.findByInterview.mockResolvedValueOnce(migratedFeedback);
    await expect(replay.service.importInterviewFromMigration(
      'migration-replay',
      { ...migrationInput, targetId: INTERVIEW_ID },
    )).resolves.toMatchObject({ interview: { id: INTERVIEW_ID, status: 'completed' } });
    expect(replay.interviews.insertMigrated).not.toHaveBeenCalled();
    expect(replay.outbox.append).not.toHaveBeenCalled();

    const drifted = fixture({
      actorType: 'service',
      scopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    drifted.interviews.findById.mockResolvedValueOnce({
      ...migratedInterview,
      location: 'drifted',
    });
    drifted.interviews.findMigrationEvidenceById.mockResolvedValueOnce({
      migrationEvidenceRef: migrationInput.migrationEvidenceRef,
      migrationEvidenceChecksum: migrationInput.evidenceChecksum,
    });
    drifted.feedback.findByInterview.mockResolvedValueOnce(migratedFeedback);
    await expect(drifted.service.importInterviewFromMigration(
      'migration-drifted',
      { ...migrationInput, targetId: INTERVIEW_ID },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_INTERVIEW_IMMUTABLE' },
    });
  });

  it('评价提交拒绝无法映射或已失效的面试官', async () => {
    const noProfile = fixture();
    noProfile.profiles.resolveActive.mockResolvedValueOnce(null);
    await expect(noProfile.service.submitFeedback(
      INTERVIEW_ID, 1, 'feedback-profile-missing',
      { recommendation: 'hire', score: 4, notes: '评价' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_INTERVIEWER_IDENTITY_INVALID' },
    });

    const inactive = fixture({ employeeStatus: 'terminated' });
    await expect(inactive.service.submitFeedback(
      INTERVIEW_ID, 1, 'feedback-employee-inactive',
      { recommendation: 'hire', score: 4, notes: '评价' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEWER_INACTIVE' } });
  });

  it('评价提交对非本轮面试官和版本冲突使用稳定错误语义', async () => {
    const denied = fixture();
    denied.profiles.resolveActive.mockResolvedValueOnce({ employeeId: 'employee-003' });
    await expect(denied.service.submitFeedback(
      INTERVIEW_ID, 1, 'feedback-assignment-denied',
      { recommendation: 'hire', score: 4, notes: '评价' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_FEEDBACK_SUBMIT_DENIED' } });

    const conflict = fixture();
    await expect(conflict.service.submitFeedback(
      INTERVIEW_ID, 2, 'feedback-version-conflict',
      { recommendation: 'hire', score: 4, notes: '评价' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const writeConflict = fixture();
    writeConflict.interviews.replace.mockRejectedValueOnce(new RecruitmentWriteConflictError());
    await expect(writeConflict.service.submitFeedback(
      INTERVIEW_ID, 1, 'feedback-write-conflict',
      { recommendation: 'hire', score: 4, notes: '评价' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });
  });

  it('仓储乐观锁冲突统一映射为稳定版本冲突', async () => {
    const conflict = fixture();
    conflict.interviews.replace.mockRejectedValueOnce(new RecruitmentWriteConflictError());
    await expect(conflict.service.cancel(
      INTERVIEW_ID, 1, 'cancel-write-conflict',
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });
  });

  it('完成要求全部评价，取消则原子写入终态和事件', async () => {
    const incomplete = fixture({ feedbackIds: ['employee-001'] });
    await expect(incomplete.service.complete(
      INTERVIEW_ID, 1, 'complete-feedback-incomplete',
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_FEEDBACK_INCOMPLETE' } });
    expect(incomplete.interviews.replace).not.toHaveBeenCalled();

    const cancelled = fixture();
    await expect(cancelled.service.cancel(
      INTERVIEW_ID, 1, 'cancel-success',
    )).resolves.toMatchObject({ interview: { status: 'cancelled', version: 2 } });
    expect(cancelled.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.interview.cancelled',
    }), SESSION);
  });

  it('终态变更重新校验申请、职位和部门写范围', async () => {
    const missingApplication = fixture();
    missingApplication.applications.findById.mockResolvedValueOnce(null);
    await expect(missingApplication.service.cancel(
      INTERVIEW_ID, 1, 'cancel-application-missing',
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_FOUND' } });

    const missingPosition = fixture();
    missingPosition.positions.findById.mockResolvedValueOnce(null);
    await expect(missingPosition.service.cancel(
      INTERVIEW_ID, 1, 'cancel-position-missing',
    )).rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');

    const denied = fixture({ actorDepartments: [] });
    await expect(denied.service.cancel(
      INTERVIEW_ID, 1, 'cancel-department-denied',
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_WRITE_DENIED' } });
    expect(denied.interviews.replace).not.toHaveBeenCalled();
  });

  it('读取对缺失引用失败关闭，并允许全局或部门范围', async () => {
    const missingInterview = fixture();
    missingInterview.interviews.findById.mockResolvedValueOnce(null);
    await expect(missingInterview.service.get(INTERVIEW_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_NOT_FOUND' } });

    const missingApplication = fixture();
    missingApplication.applications.findById.mockResolvedValueOnce(null);
    await expect(missingApplication.service.get(INTERVIEW_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_FOUND' } });

    const missingPosition = fixture();
    missingPosition.positions.findById.mockResolvedValueOnce(null);
    await expect(missingPosition.service.get(INTERVIEW_ID))
      .rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');

    const readAll = fixture({
      actorDepartments: [],
      scopes: ['erp:recruitment:interview:read_all'],
    });
    readAll.profiles.resolveActive.mockResolvedValueOnce(null);
    await expect(readAll.service.get(INTERVIEW_ID))
      .resolves.toMatchObject({ id: INTERVIEW_ID });

    const department = fixture();
    department.profiles.resolveActive.mockResolvedValueOnce(null);
    await expect(department.service.get(INTERVIEW_ID))
      .resolves.toMatchObject({ id: INTERVIEW_ID });
  });
});
