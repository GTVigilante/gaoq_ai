import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { EmployeeRepository } from '../../org/persistence/org.repositories.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  CandidateApplicationRepository,
  RecruitmentInterviewFeedbackRepository,
  RecruitmentInterviewRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentInterviewService } from './recruitment-interview.service.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';
const SESSION = { id: 'session' } as unknown as ClientSession;

const application = {
  id: APPLICATION_ID, tenantId: 'tenant-001', candidateId: 'candidate-001',
  positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8', consentEvidenceId: 'consent-001',
  sourceChannel: 'portal', stage: 'interview' as const, completedInterviewId: null,
  offerId: null, acceptanceEvidenceId: null, onboardingInstanceId: null, employmentId: null,
  version: 3, appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
  updatedAt: '2026-07-21T00:00:00.000Z',
};
const interview = {
  id: INTERVIEW_ID, tenantId: 'tenant-001', applicationId: APPLICATION_ID,
  roundNumber: 1, mode: 'video' as const, startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z', timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001', 'employee-002'], location: 'https://meeting.example/secret',
  status: 'scheduled' as const, version: 1, completedAt: null, cancelledAt: null,
  createdBy: 'actor-hr', createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

function fixture(options?: {
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
      actorId: 'actor-001', tenantId: 'tenant-001', actorType: 'user' as const,
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
  const positions = { findById: vi.fn().mockResolvedValue({
    id: application.positionId, departmentId: 'department-001', status: 'open',
  }) };
  const interviews = {
    findById: vi.fn().mockResolvedValue(interview),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const feedback = {
    append: vi.fn().mockResolvedValue(undefined),
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

describe('RecruitmentInterviewService', () => {
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
    const allowed = fixture({ scopes: ['erp:integration:calendar:deliver'] });
    const result = await allowed.service.getCalendarProjectionForIntegration(INTERVIEW_ID);
    expect(result).toMatchObject({
      interviewId: INTERVIEW_ID, location: 'https://meeting.example/secret', version: 1,
    });
    expect(result).not.toHaveProperty('candidateId');
  });
});
