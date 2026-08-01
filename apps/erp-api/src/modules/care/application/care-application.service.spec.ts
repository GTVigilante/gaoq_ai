import type { ClientSession } from 'mongoose';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import {
  CareDomainError,
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
import { CareWriteConflictError } from '../persistence/care.repositories.js';
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

function draftCase(): CareCase {
  return createOffboardingCase({
    id: 'care-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    employmentId: 'employment-001', separationType: 'voluntary_resignation',
    reasonCode: 'PERSONAL_REASON', lastWorkingDate: '2026-07-20',
    tenantTimeZone: 'Asia/Shanghai', accessDisableAt: '2026-07-20T10:00:00.000Z',
  }, NOW);
}

function readyCase(): CareCase {
  let value = approvedCase();
  for (const [taskCode, evidenceId] of [
    ['handover_accepted', 'evidence-001'], ['assets_cleared', 'evidence-002'],
    ['finance_cleared', 'evidence-003'], ['data_retention_confirmed', 'evidence-004'],
  ] as const) value = recordCareTaskEvidence(value, {
    tenantId: 'tenant-001', expectedVersion: value.version, taskCode, evidenceId,
    evidenceRecordId: `record-${value.version}`, actorId: 'actor-001',
  }, NOW).careCase;
  return value;
}

function scheduledCase(): CareCase {
  const value = readyCase();
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
  let failSecondReplace = true;
  const cases = {
    findById: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(id === careCase.id ? careCase : null)),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockImplementation((next: CareCase) => {
      replaceCalls += 1;
      if (failSecondReplace && replaceCalls === 2) {
        return Promise.reject(new Error('本地完成暂时失败'));
      }
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
    context, service, trusted, cases, evidence, outbox, organization, executionQueue, alumni, approvals,
    taskEvidenceVerifier, consentVerifier, idempotency,
    allowCompletion() { failSecondReplace = false; },
    get careCase() { return careCase; },
    get alumniConsent() { return alumniConsent; },
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

describe('CareApplicationService 离职案件与审批控制面', () => {
  it('使用可信组织主数据创建离职案件并发布事件', async () => {
    const store = fixture(draftCase());
    store.allowCompletion();
    store.organization.getEmploymentForCare.mockResolvedValueOnce(activeEmployment());
    const input = {
      employmentId: 'employment-001',
      separationType: 'voluntary_resignation' as const,
      reasonCode: 'PERSONAL_REASON',
      lastWorkingDate: '2026-08-20',
      tenantTimeZone: 'Asia/Shanghai',
      accessDisableAt: '2026-08-20T10:00:00.000Z',
    };
    const result = await store.context.run(
      scoped(store, ['erp:care:case:create']),
      () => store.service.create('care-create-001', input),
    );
    expect(result.careCase).toMatchObject({
      employeeId: 'employee-001',
      employmentId: 'employment-001',
      status: 'draft',
      version: 1,
    });
    expect(store.cases.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', employeeId: 'employee-001' }),
      SESSION,
    );
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.case.created' }),
      SESSION,
    );
  });

  it.each([
    ['劳动关系已离职', { employment: { status: 'resigned' } }],
    ['劳动关系已有结束日', { employment: { effectiveTo: '2026-07-20' } }],
    ['员工已终止', { employee: { status: 'terminated' } }],
  ])('%s时拒绝重复创建案件', async (_name, override) => {
    const store = fixture(draftCase());
    store.organization.getEmploymentForCare.mockResolvedValueOnce(
      mergeEmployment(activeEmployment(), override),
    );
    await expect(store.context.run(
      scoped(store, ['erp:care:case:create']),
      () => store.service.create('care-create-001', {
        employmentId: 'employment-001',
        separationType: 'voluntary_resignation',
        reasonCode: 'PERSONAL_REASON',
        lastWorkingDate: '2026-08-20',
        tenantTimeZone: 'Asia/Shanghai',
        accessDisableAt: '2026-08-20T10:00:00.000Z',
      }),
    )).rejects.toMatchObject({
      response: { code: 'CARE_EMPLOYMENT_ALREADY_TERMINATED' },
    });
  });

  it('部门写范围默认拒绝，write_all 可显式放行', async () => {
    const denied = fixture(draftCase());
    denied.organization.getEmploymentForCare.mockResolvedValue(activeEmployment());
    await expect(denied.context.run(
      scoped(denied, ['erp:care:case:create'], ['department-other']),
      () => denied.service.create('care-create-denied', {
        employmentId: 'employment-001',
        separationType: 'voluntary_resignation',
        reasonCode: 'PERSONAL_REASON',
        lastWorkingDate: '2026-08-20',
        tenantTimeZone: 'Asia/Shanghai',
        accessDisableAt: '2026-08-20T10:00:00.000Z',
      }),
    )).rejects.toMatchObject({ response: { code: 'CARE_DATA_SCOPE_DENIED' } });

    const allowed = fixture(draftCase());
    allowed.organization.getEmploymentForCare.mockResolvedValue(activeEmployment());
    await expect(allowed.context.run(
      scoped(allowed, ['erp:care:case:create', 'erp:care:case:write_all'], []),
      () => allowed.service.create('care-create-all', {
        employmentId: 'employment-001',
        separationType: 'voluntary_resignation',
        reasonCode: 'PERSONAL_REASON',
        lastWorkingDate: '2026-08-20',
        tenantTimeZone: 'Asia/Shanghai',
        accessDisableAt: '2026-08-20T10:00:00.000Z',
      }),
    )).resolves.toMatchObject({ careCase: { status: 'draft' } });
  });

  it('读取案件和 MCP 摘要时执行部门范围并隐藏 R3 证明', async () => {
    const store = fixture(completedCase());
    const value = await store.context.run(
      scoped(store, ['erp:care:case:read']),
      () => store.service.getForMcp('care-001'),
    );
    expect(value).toMatchObject({
      id: 'care-001',
      status: 'completed',
      version: 10,
    });
    expect(value).not.toHaveProperty('reasonCode');
    expect(JSON.stringify(value)).not.toMatch(/executionEvidence|terminationEvidence/iu);
  });

  it('读取案件拒绝越权部门、缺失 Scope 和不存在记录', async () => {
    const denied = fixture();
    await expect(denied.context.run(
      scoped(denied, ['erp:care:case:read'], ['department-other']),
      () => denied.service.get('care-001'),
    )).rejects.toMatchObject({ response: { code: 'CARE_DATA_SCOPE_DENIED' } });

    const noScope = fixture();
    await expect(noScope.context.run(
      scoped(noScope, []),
      () => noScope.service.get('care-001'),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const missing = fixture();
    await expect(missing.context.run(
      scoped(missing, ['erp:care:case:read', 'erp:care:case:read_all'], []),
      () => missing.service.get('missing'),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('创建并提交审批后使用派生幂等键绑定案件', async () => {
    const store = fixture(draftCase());
    store.allowCompletion();
    store.organization.getEmploymentForCare.mockResolvedValue(activeEmployment());
    store.approvals.createInstance.mockResolvedValue({
      instance: { id: 'approval-new', version: 1 },
    });
    store.approvals.submitInstance.mockResolvedValue({
      instance: { id: 'approval-new', version: 2, status: 'running' },
    });
    const result = await store.context.run(
      scoped(store, ['erp:care:case:submit']),
      () => store.service.submit('care-001', 1, 'care-submit-root'),
    );
    expect(result.careCase).toMatchObject({
      status: 'pending_approval',
      approvalInstanceId: 'approval-new',
      version: 2,
    });
    const approvalKey = store.approvals.createInstance.mock.calls[0]?.[0] as
      | string
      | undefined;
    const approvalInput = store.approvals.createInstance.mock.calls[0]?.[1] as {
      readonly templateCode?: string;
      readonly formData?: Readonly<Record<string, unknown>>;
    } | undefined;
    expect(approvalKey).toMatch(/^care:[A-Za-z0-9_-]{43}$/);
    expect(approvalInput).toMatchObject({
      templateCode: 'care_offboarding',
      formData: { care_case_id: 'care-001' },
    });
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.case.approval_submitted' }),
      SESSION,
    );
  });

  it('审批未进入 running/approved 时失败关闭且不绑定案件', async () => {
    const store = fixture(draftCase());
    store.organization.getEmploymentForCare.mockResolvedValue(activeEmployment());
    store.approvals.createInstance.mockResolvedValue({
      instance: { id: 'approval-new', version: 1 },
    });
    store.approvals.submitInstance.mockResolvedValue({
      instance: { id: 'approval-new', version: 1, status: 'draft' },
    });
    await expect(store.context.run(
      scoped(store, ['erp:care:case:submit']),
      () => store.service.submit('care-001', 1, 'care-submit-invalid'),
    )).rejects.toMatchObject({
      response: { code: 'CARE_APPROVAL_SUBMIT_INVALID' },
    });
    expect(store.cases.replace).not.toHaveBeenCalled();
  });

  it('同步审批的 approved 与 rejected 终态并发布对应事件', async () => {
    for (const outcome of ['approved', 'rejected'] as const) {
      const store = fixture(pendingCase());
      store.allowCompletion();
      store.approvals.getInstanceStatusForCare.mockResolvedValue({
        id: 'approval-001',
        status: outcome,
      });
      const result = await store.context.run(
        scoped(store, ['erp:care:approval:sync']),
        () => store.service.syncApproval('care-001', 2, `sync-${outcome}`),
      );
      expect(result.careCase.status).toBe(
        outcome === 'approved' ? 'approved' : 'cancelled',
      );
      expect(store.outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: outcome === 'approved' ? 'care.case.approved' : 'care.case.rejected',
        }),
        SESSION,
      );
    }
  });

  it('同步审批拒绝非待审批状态、非终态和丢失引用', async () => {
    const draft = fixture(draftCase());
    await expect(draft.context.run(
      scoped(draft, ['erp:care:approval:sync']),
      () => draft.service.syncApproval('care-001', 1, 'sync-draft'),
    )).rejects.toMatchObject({ response: { code: 'CARE_APPROVAL_SYNC_INVALID' } });

    const running = fixture(pendingCase());
    running.approvals.getInstanceStatusForCare.mockResolvedValue({
      id: 'approval-001',
      status: 'running',
    });
    await expect(running.context.run(
      scoped(running, ['erp:care:approval:sync']),
      () => running.service.syncApproval('care-001', 2, 'sync-running'),
    )).rejects.toMatchObject({ response: { code: 'CARE_APPROVAL_NOT_TERMINAL' } });

    const missingRef = fixture({ ...approvedCase(), approvalInstanceId: null });
    await expect(missingRef.context.run(
      scoped(missingRef, ['erp:care:approval:sync']),
      () => missingRef.service.syncApproval('care-001', 3, 'sync-no-ref'),
    )).rejects.toThrow('CARE_APPROVAL_REFERENCE_MISSING');
  });

  it('审批和组织来源恢复时拒绝引用、版本或员工漂移', async () => {
    const linkMismatch = fixture(pendingCase());
    await expect(linkMismatch.context.run(
      scoped(linkMismatch, ['erp:care:case:submit']),
      () => linkMismatch.service.submit('care-001', 3, 'submit-mismatch'),
    )).rejects.toMatchObject({ response: { code: 'CARE_APPROVAL_LINK_MISMATCH' } });

    const resultMismatch = fixture(approvedCase());
    await expect(resultMismatch.context.run(
      scoped(resultMismatch, ['erp:care:approval:sync']),
      () => resultMismatch.service.syncApproval('care-001', 4, 'sync-mismatch'),
    )).rejects.toMatchObject({ response: { code: 'CARE_APPROVAL_RESULT_MISMATCH' } });

    const sourceChanged = fixture(draftCase());
    sourceChanged.organization.getEmploymentForCare.mockResolvedValue({
      ...activeEmployment(),
      employee: { ...activeEmployment().employee, id: 'employee-other' },
    });
    await expect(sourceChanged.context.run(
      scoped(sourceChanged, ['erp:care:case:submit']),
      () => sourceChanged.service.submit('care-001', 1, 'submit-source-changed'),
    )).rejects.toMatchObject({ response: { code: 'CARE_EMPLOYMENT_SOURCE_CHANGED' } });
  });
});

describe('CareApplicationService 清算与执行 Saga', () => {
  it.each([
    ['handover_accepted', 'erp:care:handover:attest'],
    ['assets_cleared', 'erp:care:assets:attest'],
    ['finance_cleared', 'erp:care:finance:attest'],
    ['data_retention_confirmed', 'erp:care:retention:attest'],
  ] as const)('%s 仅接受对应 Scope 并追加不可变证据', async (taskCode, scope) => {
    const store = fixture(approvedCase());
    store.allowCompletion();
    const result = await store.context.run(
      scoped(store, [scope]),
      () => store.service.recordTaskEvidence(
        'care-001',
        3,
        `evidence-${taskCode}`,
        taskCode,
        `proof-${taskCode}`,
      ),
    );
    expect(result.careCase.version).toBe(4);
    expect(store.evidence.append).toHaveBeenCalledWith(
      expect.objectContaining({ taskCode, evidenceId: `proof-${taskCode}` }),
      SESSION,
    );
    const event = store.outbox.append.mock.calls.at(-1)?.[0] as {
      readonly type?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
    } | undefined;
    expect(event).toMatchObject({
      type: 'care.case.task_completed',
      payload: { taskCode },
    });
  });

  it('重复清算证据幂等收敛且错误 Scope 被拒绝', async () => {
    const store = fixture(approvedCase());
    store.allowCompletion();
    const context = scoped(store, ['erp:care:assets:attest']);
    await store.context.run(context, () => store.service.recordTaskEvidence(
      'care-001', 3, 'evidence-1', 'assets_cleared', 'proof-assets',
    ));
    vi.clearAllMocks();
    const result = await store.context.run(context, () => store.service.recordTaskEvidence(
      'care-001', 4, 'evidence-2', 'assets_cleared', 'proof-assets',
    ));
    expect(result.careCase.version).toBe(4);
    expect(store.cases.replace).not.toHaveBeenCalled();
    expect(store.evidence.append).not.toHaveBeenCalled();

    await expect(store.context.run(
      scoped(store, ['erp:care:finance:attest']),
      () => store.service.recordTaskEvidence(
        'care-001', 4, 'evidence-3', 'assets_cleared', 'proof-other',
      ),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('四项清算完成后排程并只把最小摘要送入 Worker 队列', async () => {
    const store = fixture(readyCase());
    store.allowCompletion();
    const result = await store.context.run(
      scoped(store, ['erp:care:case:schedule']),
      () => store.service.schedule('care-001', 7, 'schedule-001'),
    );
    expect(result.careCase).toMatchObject({ status: 'scheduled', version: 8 });
    expect(store.executionQueue.schedule).toHaveBeenCalledWith(result.careCase);
    expect(JSON.stringify(store.executionQueue.schedule.mock.calls)).not.toMatch(
      /executionEvidence|terminationEvidence/iu,
    );
  });

  it('定时任务拒绝非法状态并可从 scheduled/executing/completed 恢复', async () => {
    const invalid = fixture(approvedCase());
    await expect(invalid.context.run(
      scoped(invalid, ['erp:care:execution:run']),
      () => invalid.service.executeScheduledJob('care-001', 'job-invalid'),
    )).rejects.toMatchObject({ response: { code: 'CARE_EXECUTION_STATE_INVALID' } });

    const completed = fixture(completedCase());
    await expect(completed.context.run(
      scoped(completed, ['erp:care:execution:run']),
      () => completed.service.executeScheduledJob('care-001', 'job-completed'),
    )).resolves.toMatchObject({ careCase: { status: 'completed' } });
    expect(completed.organization.terminateEmploymentFromCare).not.toHaveBeenCalled();
  });

  it('executing 快照缺少执行证明时失败关闭，不调用组织终止', async () => {
    const executing = beginCareExecution(scheduledCase(), {
      tenantId: 'tenant-001',
      expectedVersion: 8,
      executionEvidenceId: 'execution-001',
    }, new Date('2026-07-20T10:00:00.000Z'));
    const store = fixture({ ...executing, executionEvidenceId: null });
    await expect(store.context.run(
      scoped(store, ['erp:care:execution:run']),
      () => store.service.execute('care-001', 9, 'execute-missing-proof'),
    )).rejects.toThrow('CARE_EXECUTION_EVIDENCE_MISSING');
    expect(store.organization.terminateEmploymentFromCare).not.toHaveBeenCalled();
  });
});

describe('CareApplicationService 校友授权与异常语义', () => {
  it.each([
    ['案件未完成', pendingCase(), {}, 'CARE_ALUMNI_CASE_INCOMPLETE'],
    [
      '授权早于完成',
      completedCase(),
      { grantedAt: '2026-07-20T09:00:00.000Z' },
      'CARE_CONSENT_TIME_INVALID',
    ],
  ])('%s时拒绝创建校友授权', async (_name, careCase, inputOverride, code) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T11:00:00.000Z'));
    const store = fixture(careCase);
    await expect(store.context.run(
      scoped(store, ['erp:care:alumni:consent:attest']),
      () => store.service.createAlumniConsent('care-001', 'consent-invalid', {
        purpose: 'alumni_network',
        channels: ['email'],
        consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z',
        expiresAt: '2027-07-20T11:00:00.000Z',
        ...inputOverride,
      }),
    )).rejects.toMatchObject({ response: { code } });
  });

  it('拒绝超前授权、终止证明漂移和未验证授权证明', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T11:00:00.000Z'));
    const future = fixture(completedCase());
    await expect(future.context.run(
      scoped(future, ['erp:care:alumni:consent:attest']),
      () => future.service.createAlumniConsent('care-001', 'future', {
        purpose: 'alumni_network',
        channels: ['email'],
        consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:06:00.000Z',
        expiresAt: '2027-07-20T11:06:00.000Z',
      }),
    )).rejects.toMatchObject({ response: { code: 'CARE_CONSENT_TIME_INVALID' } });

    const termination = fixture(completedCase());
    termination.organization.getEmploymentForCare.mockResolvedValue({
      ...activeEmployment(),
      employment: {
        ...activeEmployment().employment,
        terminationCareCaseId: 'care-other',
        terminationEvidenceId: null,
      },
    });
    await expect(termination.context.run(
      scoped(termination, ['erp:care:alumni:consent:attest']),
      () => termination.service.createAlumniConsent('care-001', 'termination', {
        purpose: 'alumni_network',
        channels: ['email'],
        consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z',
        expiresAt: '2027-07-20T11:00:00.000Z',
      }),
    )).rejects.toMatchObject({
      response: { code: 'CARE_ALUMNI_TERMINATION_UNVERIFIED' },
    });

    const unverified = fixture(completedCase());
    unverified.consentVerifier.verify.mockResolvedValue({ verified: false });
    await expect(unverified.context.run(
      scoped(unverified, ['erp:care:alumni:consent:attest']),
      () => unverified.service.createAlumniConsent('care-001', 'unverified', {
        purpose: 'alumni_network',
        channels: ['email'],
        consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z',
        expiresAt: '2027-07-20T11:00:00.000Z',
      }),
    )).rejects.toMatchObject({ response: { code: 'CARE_CONSENT_UNVERIFIED' } });
  });

  it('授权撤回幂等、非 active 到期收敛且缺失授权返回 404', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T11:00:00.000Z'));
    const store = fixture(completedCase());
    const created = await store.context.run(
      scoped(store, ['erp:care:alumni:consent:attest']),
      () => store.service.createAlumniConsent('care-001', 'consent-create', {
        purpose: 'alumni_network',
        channels: ['email'],
        consentVersion: 'v1',
        consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
        grantedAt: '2026-07-20T11:00:00.000Z',
        expiresAt: '2027-07-20T11:00:00.000Z',
      }),
    );
    const withdrawn = await store.context.run(
      scoped(store, ['erp:care:alumni:consent:withdraw']),
      () => store.service.withdrawAlumniConsent(
        created.consent.id,
        1,
        'consent-withdraw',
      ),
    );
    expect(withdrawn.consent).toMatchObject({ status: 'withdrawn', version: 2 });
    const replaceCount = store.alumni.replace.mock.calls.length;
    await expect(store.context.run(
      scoped(store, ['erp:care:alumni:consent:withdraw']),
      () => store.service.withdrawAlumniConsent(
        created.consent.id,
        2,
        'consent-withdraw-repeat',
      ),
    )).resolves.toMatchObject({ consent: { status: 'withdrawn', version: 2 } });
    expect(store.alumni.replace).toHaveBeenCalledTimes(replaceCount);

    await expect(store.context.run(
      scoped(store, ['erp:care:alumni:consent:expire']),
      () => store.service.expireAlumniConsent(created.consent.id),
    )).resolves.toMatchObject({ consent: { status: 'withdrawn' } });

    await expect(store.context.run(
      scoped(store, ['erp:care:alumni:consent:expire']),
      () => store.service.expireAlumniConsent('missing'),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [new CareWriteConflictError(), 'CARE_VERSION_CONFLICT'],
    [new CareDomainError('CARE_CROSS_TENANT', '跨租户'), 'CARE_CROSS_TENANT'],
    [new CareDomainError('CARE_VERSION_CONFLICT', '版本冲突'), 'CARE_VERSION_CONFLICT'],
    [new CareDomainError('CARE_REASON_INVALID', '原因非法'), 'CARE_REASON_INVALID'],
    [{ code: 11_000 }, 'CARE_UNIQUE_CONFLICT'],
  ])('把仓储和领域异常映射为稳定错误码：%s', async (error, code) => {
    const store = fixture(draftCase());
    store.organization.getEmploymentForCare.mockResolvedValue(activeEmployment());
    store.cases.insert.mockRejectedValue(error);
    await expect(store.context.run(
      scoped(store, ['erp:care:case:create']),
      () => store.service.create('create-error', {
        employmentId: 'employment-001',
        separationType: 'voluntary_resignation',
        reasonCode: 'PERSONAL_REASON',
        lastWorkingDate: '2026-08-20',
        tenantTimeZone: 'Asia/Shanghai',
        accessDisableAt: '2026-08-20T10:00:00.000Z',
      }),
    )).rejects.toMatchObject({ response: { code } });
  });
});

function activeEmployment() {
  return {
    employee: {
      id: 'employee-001',
      departmentIds: ['department-001'],
      status: 'active',
    },
    employment: {
      id: 'employment-001',
      personId: 'person-001',
      status: 'active',
      effectiveTo: null as string | null,
      terminationCareCaseId: 'care-001',
      terminationEvidenceId: 'termination-001' as string | null,
    },
  };
}

function mergeEmployment(
  source: ReturnType<typeof activeEmployment>,
  override: {
    readonly employee?: Partial<ReturnType<typeof activeEmployment>['employee']>;
    readonly employment?: Partial<ReturnType<typeof activeEmployment>['employment']>;
  },
) {
  return {
    employee: { ...source.employee, ...override.employee },
    employment: { ...source.employment, ...override.employment },
  };
}

function scoped(
  store: ReturnType<typeof fixture>,
  scopes: readonly string[],
  departmentIds: readonly string[] = ['department-001'],
) {
  return {
    ...store.trusted,
    actor: {
      ...store.trusted.actor,
      scopes: [...scopes],
      departmentIds: [...departmentIds],
    },
  };
}
