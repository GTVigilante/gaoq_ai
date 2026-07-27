import type { ClientSession } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import {
  approveCareCase,
  beginCareExecution,
  completeCareExecution,
  createOffboardingCase,
  recordCareTaskEvidence,
  scheduleCareExecution,
  submitCareCaseForApproval,
  type AlumniConsent,
  type CareCase,
} from '../domain/index.js';
import type { CareOutboxWriter } from '../persistence/care-outbox.writer.js';
import type {
  CareCaseRepository,
  CareAlumniConsentRepository,
  CareTaskEvidenceRepository,
} from '../persistence/care.repositories.js';
import { CareApplicationService } from './care-application.service.js';
import type { CareExecutionQueueService } from '../care-execution-queue.service.js';

const SESSION = {} as ClientSession;
const NOW = new Date('2026-07-01T00:00:00.000Z');

afterEach(() => vi.useRealTimers());

function pendingCase(): CareCase {
  const value = createOffboardingCase({
    id: 'care-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    employmentId: 'employment-001', separationType: 'voluntary_resignation',
    reasonCode: 'PERSONAL_REASON', lastWorkingDate: '2026-07-20',
    tenantTimeZone: 'Asia/Shanghai', accessDisableAt: '2026-07-20T10:00:00.000Z',
  }, NOW);
  return submitCareCaseForApproval(value, {
    tenantId: 'tenant-001', expectedVersion: 1, approvalInstanceId: 'approval-001',
  }, NOW);
}

function approvedCase(): CareCase {
  return approveCareCase(pendingCase(), {
    tenantId: 'tenant-001', expectedVersion: 2, approvalVerified: true,
  }, NOW);
}

function scheduledCase(): CareCase {
  let value = approvedCase();
  for (const [taskCode, evidenceId] of [
    ['handover_accepted', 'evidence-001'], ['assets_cleared', 'evidence-002'],
    ['finance_cleared', 'evidence-003'], ['data_retention_confirmed', 'evidence-004'],
  ] as const) value = recordCareTaskEvidence(value, {
    tenantId: 'tenant-001', expectedVersion: value.version, taskCode, evidenceId,
    evidenceRecordId: `record-${value.version}`, actorId: 'actor-001',
  }, NOW).careCase;
  return scheduleCareExecution(value, {
    tenantId: 'tenant-001', expectedVersion: value.version,
  }, NOW);
}

function completedCase(): CareCase {
  const scheduled = scheduledCase();
  const executing = beginCareExecution(scheduled, {
    tenantId: 'tenant-001', expectedVersion: 8, executionEvidenceId: 'execution-001',
  }, new Date('2026-07-20T10:00:00.000Z'));
  return completeCareExecution(executing, {
    tenantId: 'tenant-001', expectedVersion: 9,
    orgTerminationEvidenceId: 'termination-001', orgTerminationVerified: true,
  }, new Date('2026-07-20T10:00:01.000Z'));
}

function fixture(initial = scheduledCase()) {
  const context = new TenantContextService();
  let careCase = initial;
  let alumniConsent: AlumniConsent | null = null;
  let replaceCalls = 0;
  const cases = {
    findById: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(id === careCase.id ? careCase : null)),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockImplementation((next: CareCase) => {
      replaceCalls += 1;
      if (replaceCalls === 2) return Promise.reject(new Error('本地完成暂时失败'));
      careCase = next;
      return Promise.resolve();
    }),
  };
  const evidence = { append: vi.fn().mockResolvedValue(undefined) };
  const alumni = {
    findById: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(alumniConsent?.id === id ? alumniConsent : null)),
    insert: vi.fn().mockImplementation((value: AlumniConsent) => {
      alumniConsent = value;
      return Promise.resolve();
    }),
    replace: vi.fn().mockImplementation((value: AlumniConsent) => {
      alumniConsent = value;
      return Promise.resolve();
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const approvals = {
    createInstance: vi.fn(), submitInstance: vi.fn(), getInstanceStatusForCare: vi.fn(),
  };
  const organization = {
    getEmploymentForCare: vi.fn().mockResolvedValue({
      employee: { id: 'employee-001', departmentIds: ['department-001'], status: 'active' },
      employment: {
        id: 'employment-001', personId: 'person-001', status: 'resigned',
        effectiveTo: '2026-07-20', terminationCareCaseId: 'care-001',
        terminationEvidenceId: 'termination-001',
      },
    }),
    terminateEmploymentFromCare: vi.fn().mockResolvedValue({
      terminationEvidenceId: 'termination-001',
    }),
  };
  const executionQueue = {
    schedule: vi.fn().mockResolvedValue(undefined),
    scheduleAlumniConsentExpiry: vi.fn().mockResolvedValue(undefined),
  };
  const taskEvidenceVerifier = { verify: vi.fn().mockResolvedValue({ verified: true }) };
  const consentVerifier = { verify: vi.fn().mockResolvedValue({ verified: true }) };
  const idempotency = { execute: vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  ) };
  const service = new CareApplicationService(
    idempotency as unknown as IdempotencyService,
    context,
    cases as unknown as CareCaseRepository,
    evidence as unknown as CareTaskEvidenceRepository,
    alumni as unknown as CareAlumniConsentRepository,
    outbox as unknown as CareOutboxWriter,
    approvals as unknown as ApprovalApplicationService,
    organization as unknown as OrgApplicationService,
    executionQueue as unknown as CareExecutionQueueService,
    taskEvidenceVerifier,
    consentVerifier,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
    actor: {
      actorId: 'care-worker', actorType: 'service' as const, tenantId: 'tenant-001',
      roleCodes: [], departmentIds: ['department-001'], traceId: 'trace-001',
      scopes: ['erp:care:execution:run', 'erp:care:employment:terminate'],
    },
  };
  return {
    context, service, trusted, cases, outbox, organization, executionQueue, alumni, approvals,
    taskEvidenceVerifier, consentVerifier, idempotency,
    allowCompletion() { replaceCalls = 0; },
    get careCase() { return careCase; },
  };
}

describe('CareApplicationService', () => {
  it('组织终止成功而本地完成失败后，可用不同根键从 executing 续跑', async () => {
    const store = fixture();
    await expect(store.context.run(store.trusted, () => store.service.execute(
      'care-001', 8, 'care-execute-001',
    ))).rejects.toThrow('本地完成暂时失败');
    expect(store.careCase).toMatchObject({ status: 'executing', version: 9 });
    expect(store.organization.terminateEmploymentFromCare).toHaveBeenCalledOnce();
    store.allowCompletion();
    const result = await store.context.run(store.trusted, () => store.service.execute(
      'care-001', 9, 'care-execute-retry',
    ));
    expect(result.careCase).toMatchObject({ status: 'completed', version: 10 });
    expect(result.careCase).not.toHaveProperty('executionEvidenceId');
    expect(result.careCase).not.toHaveProperty('orgTerminationEvidenceId');
    expect(store.organization.terminateEmploymentFromCare).toHaveBeenCalledTimes(2);
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('R3 执行仍强制乐观版本，不能用陈旧快照触发', async () => {
    const store = fixture();
    await expect(store.context.run(store.trusted, () => store.service.execute(
      'care-001', 7, 'care-execute-stale',
    ))).rejects.toMatchObject({ response: { code: 'CARE_VERSION_CONFLICT' } });
    expect(store.organization.terminateEmploymentFromCare).not.toHaveBeenCalled();
  });

  it('校友授权只接受受信任证据，响应与事件不暴露证明标识和自然人标识', async () => {
    const store = fixture(completedCase());
    const consentContext = {
      ...store.trusted,
      actor: {
        ...store.trusted.actor,
        scopes: ['erp:care:alumni:consent:attest', 'erp:care:employment:read'],
      },
    };
    const result = await store.context.run(consentContext, () =>
      store.service.createAlumniConsent('care-001', 'care-consent-001', {
        purpose: 'alumni_network', channels: ['email'], consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z', expiresAt: '2027-07-20T11:00:00.000Z',
      }),
    );
    const inserted = store.alumni.insert.mock.calls[0]?.[0] as {
      readonly personId?: string;
      readonly consentEvidenceId?: string;
    } | undefined;
    expect(inserted).toMatchObject({
      personId: 'person-001', consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
    });
    expect(store.alumni.insert.mock.calls[0]?.[1]).toBe(SESSION);
    expect(JSON.stringify(result)).not.toMatch(/personId|consentEvidenceId/iu);
    const event = store.outbox.append.mock.calls[0]?.[0] as { payload?: unknown } | undefined;
    expect(JSON.stringify(event?.payload)).not.toMatch(/personId|consentEvidenceId/iu);
    expect(store.executionQueue.scheduleAlumniConsentExpiry).toHaveBeenCalledWith(result.consent);
  });

  it('校友授权幂等快照重放不再读取已变化的离职状态', async () => {
    const store = fixture(pendingCase());
    store.idempotency.execute.mockResolvedValueOnce({
      consent: {
        id: 'consent-001', careCaseId: 'care-001', purpose: 'alumni_network',
        channels: ['email'], grantedAt: '2026-07-20T11:00:00.000Z',
        expiresAt: '2027-07-20T11:00:00.000Z', status: 'active', version: 1,
      },
    });
    const consentContext = {
      ...store.trusted,
      actor: { ...store.trusted.actor, scopes: ['erp:care:alumni:consent:attest'] },
    };
    await expect(store.context.run(consentContext, () => store.service.createAlumniConsent(
      'care-001', 'care-consent-replay-001', {
        purpose: 'alumni_network', channels: ['email'], consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z', expiresAt: '2027-07-20T11:00:00.000Z',
      },
    ))).resolves.toMatchObject({ consent: { id: 'consent-001' } });
    expect(store.cases.findById).not.toHaveBeenCalled();
    expect(store.organization.getEmploymentForCare).not.toHaveBeenCalled();
    expect(store.consentVerifier.verify).not.toHaveBeenCalled();
    expect(store.executionQueue.scheduleAlumniConsentExpiry).toHaveBeenCalledOnce();
  });

  it('Worker 到期后终止授权并发布不含自然人标识的事件', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T11:00:00.000Z'));
    const store = fixture(completedCase());
    const attestContext = {
      ...store.trusted,
      actor: {
        ...store.trusted.actor,
        scopes: ['erp:care:alumni:consent:attest', 'erp:care:employment:read'],
      },
    };
    const created = await store.context.run(attestContext, () =>
      store.service.createAlumniConsent('care-001', 'care-consent-expiry-001', {
        purpose: 'alumni_network', channels: ['email'], consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z', expiresAt: '2027-07-20T11:00:00.000Z',
      }),
    );
    vi.setSystemTime(new Date('2027-07-20T11:00:00.000Z'));
    const expiryContext = {
      ...store.trusted,
      actor: {
        ...store.trusted.actor,
        actorId: 'system:care-consent-expiry', actorType: 'system_job' as const,
        scopes: ['erp:care:alumni:consent:expire'],
      },
    };
    const result = await store.context.run(expiryContext, () =>
      store.service.expireAlumniConsent(created.consent.id),
    );
    expect(result.consent).toMatchObject({ status: 'expired', version: 2 });
    const event = store.outbox.append.mock.calls.at(-1)?.[0] as {
      readonly type?: string;
      readonly payload?: unknown;
    } | undefined;
    expect(event?.type).toBe('care.alumni_consent.expired');
    expect(JSON.stringify(event)).not.toMatch(/personId|consentEvidenceId/iu);
  });

  it('已绑定或已批准的审批步骤可用当前版本和不同根键恢复', async () => {
    const pending = fixture(pendingCase());
    const submitContext = {
      ...pending.trusted,
      actor: {
        ...pending.trusted.actor,
        scopes: ['erp:care:case:submit', 'erp:care:employment:read'],
      },
    };
    const linked = await pending.context.run(submitContext, () =>
      pending.service.submit('care-001', 2, 'care-submit-recovery'),
    );
    expect(linked.careCase).toMatchObject({ status: 'pending_approval', version: 2 });
    expect(pending.approvals.createInstance).not.toHaveBeenCalled();

    const approved = fixture(approvedCase());
    const approvalContext = {
      ...approved.trusted,
      actor: { ...approved.trusted.actor, scopes: ['erp:care:approval:sync'] },
    };
    const synced = await approved.context.run(approvalContext, () =>
      approved.service.syncApproval('care-001', 3, 'care-sync-recovery'),
    );
    expect(synced.careCase).toMatchObject({ status: 'approved', version: 3 });
    expect(approved.approvals.getInstanceStatusForCare).not.toHaveBeenCalled();
  });

  it('清算证据校验器未确认时失败关闭且不写案件', async () => {
    const store = fixture(approvedCase());
    store.taskEvidenceVerifier.verify.mockResolvedValueOnce({ verified: false });
    const evidenceContext = {
      ...store.trusted,
      actor: { ...store.trusted.actor, scopes: ['erp:care:assets:attest'] },
    };
    await expect(store.context.run(evidenceContext, () => store.service.recordTaskEvidence(
      'care-001', 3, 'care-evidence-unverified', 'assets_cleared', 'evidence-001',
    ))).rejects.toMatchObject({ response: { code: 'CARE_TASK_EVIDENCE_UNVERIFIED' } });
    expect(store.cases.replace).not.toHaveBeenCalled();
  });
});
