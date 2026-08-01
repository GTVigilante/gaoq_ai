import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import {
  TenantContextService,
  type TrustedRequestContext,
} from '../../../core/tenant/tenant-context.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import type { RecruitmentOnboardingBridgeService } from '../../recruitment/application/recruitment-onboarding-bridge.service.js';
import {
  beginOnboardingProvisioning,
  completeOnboardingProvisioning,
  createOnboardingInstance,
  OnboardingDomainError,
  recordOnboardingTaskEvidence,
  type OnboardingInstance,
} from '../domain/index.js';
import type { OnboardingOutboxWriter } from '../persistence/onboarding-outbox.writer.js';
import { OnboardingWriteConflictError } from '../persistence/onboarding.repositories.js';
import type {
  OnboardingInstanceRepository,
  OnboardingTaskEvidenceRepository,
} from '../persistence/onboarding.repositories.js';
import { OnboardingApplicationService } from './onboarding-application.service.js';

const SESSION = {} as ClientSession;
const NOW = new Date('2026-07-21T00:00:00.000Z');

const source = {
  offerId: 'offer-001', applicationId: 'application-001', candidateId: 'candidate-001',
  candidateDisplayName: '候选人甲', acceptanceEvidenceId: 'acceptance-001',
  signedEvidenceId: 'contract_archived-evidence', proposedStartDate: '2026-08-01',
  departmentId: 'department-001', jobLevelId: 'level-001',
};

function inProgressInstance(
  signedEvidenceId: string | null = null,
): OnboardingInstance {
  return createOnboardingInstance({
    id: 'onboarding-001',
    tenantId: 'tenant-001',
    offerId: source.offerId,
    applicationId: source.applicationId,
    candidateId: source.candidateId,
    acceptanceEvidenceId: source.acceptanceEvidenceId,
    signedEvidenceId,
    departmentId: source.departmentId,
    jobLevelId: source.jobLevelId,
    proposedStartDate: source.proposedStartDate,
  }, NOW);
}

function readyInstance(): OnboardingInstance {
  let current = inProgressInstance();
  for (const taskCode of [
    'contract_archived', 'identity_verified', 'materials_verified',
    'org_assignment_verified', 'mandatory_training_completed',
  ] as const) {
    current = recordOnboardingTaskEvidence(current, {
      tenantId: 'tenant-001', expectedVersion: current.version, taskCode,
      evidenceId: `${taskCode}-evidence`, evidenceRecordId: `${taskCode}-record`,
      actorId: 'actor-001',
      ...(taskCode === 'org_assignment_verified' ? { orgPositionId: 'org-position-001' } : {}),
    }, NOW).instance;
  }
  return current;
}

function provisioningInstance(): OnboardingInstance {
  const current = readyInstance();
  return beginOnboardingProvisioning(current, {
    tenantId: current.tenantId,
    expectedVersion: current.version,
    completionEvidenceId: 'completion-evidence-001',
  }, NOW);
}

function completedInstance(employmentId = 'employment-001'): OnboardingInstance {
  const current = provisioningInstance();
  return completeOnboardingProvisioning(current, {
    tenantId: current.tenantId,
    expectedVersion: current.version,
    completionEvidenceId: current.completionEvidenceId ?? '',
    employmentId,
  }, NOW);
}

function fixture(initial: OnboardingInstance | null = null) {
  const context = new TenantContextService();
  let stored = initial;
  const instances = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    findByOfferId: vi.fn().mockImplementation(() =>
      Promise.resolve(stored?.offerId === source.offerId ? stored : null)),
    insert: vi.fn().mockImplementation((value: OnboardingInstance) => {
      stored = value;
      return Promise.resolve();
    }),
    replace: vi.fn().mockImplementation((value: OnboardingInstance) => {
      stored = value;
      return Promise.resolve();
    }),
  };
  const evidence = { append: vi.fn().mockResolvedValue(undefined) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const recruitment = {
    getOnboardingSource: vi.fn().mockResolvedValue(source),
    markPreboarding: vi.fn().mockResolvedValue({ applicationId: source.applicationId, stage: 'preboarding' }),
    markHired: vi.fn().mockResolvedValue({ applicationId: source.applicationId, stage: 'hired' }),
  };
  const org = {
    validateOnboardingAssignment: vi.fn().mockResolvedValue({ verified: true }),
    establishEmploymentFromOnboarding: vi.fn().mockResolvedValue({
      employment: { id: 'employment-001' }, employeeId: 'employee-001',
      employeeNo: 'E2026000001', personId: 'person-001',
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
  const service = new OnboardingApplicationService(
    idempotency as unknown as IdempotencyService,
    context,
    instances as unknown as OnboardingInstanceRepository,
    evidence as unknown as OnboardingTaskEvidenceRepository,
    outbox as unknown as OnboardingOutboxWriter,
    recruitment as unknown as RecruitmentOnboardingBridgeService,
    org as unknown as OrgApplicationService,
  );
  const trusted: TrustedRequestContext = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'onboarding-worker', actorType: 'service' as const, tenantId: 'tenant-001',
      roleCodes: [], departmentIds: [], traceId: 'trace-001',
      scopes: [
        'erp:onboarding:create', 'erp:onboarding:read', 'erp:onboarding:write_all',
        'erp:onboarding:task:complete', 'erp:onboarding:contract:attest',
        'erp:identity:onboarding:attest',
        'erp:knowledge:onboarding:attest', 'erp:onboarding:complete',
        'erp:onboarding:org:validate', 'erp:onboarding:employment:establish',
      ],
    },
  };
  return {
    service, context, trusted, instances, evidence, outbox, recruitment, org, idempotency,
    get stored() { return stored; },
    setStored(value: OnboardingInstance | null) { stored = value; },
  };
}

async function runAs<T>(
  store: ReturnType<typeof fixture>,
  operation: () => Promise<T>,
  actor: Partial<TrustedRequestContext['actor']> = {},
): Promise<T> {
  return store.context.run({
    tenant: store.trusted.tenant,
    actor: { ...store.trusted.actor, ...actor },
  }, operation);
}

describe('OnboardingApplicationService', () => {
  it('先落入职实例再通过招聘窄桥推进 preboarding', async () => {
    const store = fixture();
    const result = await store.context.run(store.trusted, () =>
      store.service.createFromOffer('offer-001', 'onboarding-create-001'),
    );
    expect(result.onboarding.status).toBe('in_progress');
    expect(store.instances.insert).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: 'offer-001' }), SESSION,
    );
    expect(store.recruitment.markPreboarding).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      { offerId: 'offer-001', onboardingInstanceId: result.onboarding.id },
    );
  });

  it('组织分配证据落库前必须由 Org 应用服务校验正式岗位', async () => {
    const store = fixture(createOnboardingInstance({
      id: 'onboarding-001', tenantId: 'tenant-001', offerId: source.offerId,
      applicationId: source.applicationId, candidateId: source.candidateId,
      acceptanceEvidenceId: source.acceptanceEvidenceId, signedEvidenceId: null,
      departmentId: source.departmentId, jobLevelId: source.jobLevelId,
      proposedStartDate: source.proposedStartDate,
    }, NOW));
    await store.context.run(store.trusted, () => store.service.recordTaskEvidence(
      'onboarding-001', 1, 'onboarding-task-001', {
        taskCode: 'org_assignment_verified', evidenceId: 'evidence-001',
        orgPositionId: 'org-position-001',
      },
    ));
    expect(store.org.validateOnboardingAssignment).toHaveBeenCalledWith({
      departmentId: 'department-001', orgPositionId: 'org-position-001',
      jobLevelId: 'level-001',
    });
    expect(store.evidence.append).toHaveBeenCalledWith(
      expect.objectContaining({ taskCode: 'org_assignment_verified' }), SESSION,
    );
  });

  it('完成 Saga 依次建立 Employment、固化 completed 并推进招聘 hired', async () => {
    const current = readyInstance();
    const store = fixture(current);
    const result = await store.context.run(store.trusted, () => store.service.complete(
      current.id, current.version, 'onboarding-complete-001',
    ));
    expect(result.onboarding).toMatchObject({ status: 'completed', employmentId: 'employment-001' });
    expect(store.org.establishEmploymentFromOnboarding).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      expect.objectContaining({
        onboardingInstanceId: current.id,
        effectiveFrom: '2026-08-01',
        orgPositionId: 'org-position-001',
      }),
    );
    expect(store.recruitment.markHired).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      expect.objectContaining({ employmentId: 'employment-001' }),
    );
    expect(store.stored?.version).toBe(8);
  });

  it('读取必须同时满足业务 Scope 与部门数据范围', async () => {
    const store = fixture(inProgressInstance());

    await expect(runAs(store, () => store.service.get('onboarding-001'), {
      scopes: [],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_SCOPE_REQUIRED' } });
    expect(store.instances.findById).not.toHaveBeenCalled();

    await expect(runAs(store, () => store.service.get('onboarding-001'), {
      scopes: ['erp:onboarding:read'],
      departmentIds: ['department-other'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_READ_DENIED' } });

    const result = await runAs(store, () => store.service.get('onboarding-001'), {
      scopes: ['erp:onboarding:read', 'erp:onboarding:read_all'],
      departmentIds: [],
    });
    expect(result).toMatchObject({
      id: 'onboarding-001',
      departmentId: 'department-001',
      status: 'in_progress',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('读取不存在实例返回稳定错误', async () => {
    const store = fixture();
    await expect(runAs(store, () => store.service.get('missing'), {
      scopes: ['erp:onboarding:read', 'erp:onboarding:read_all'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_NOT_FOUND' } });
  });

  it('创建在缺少 Scope 时不得读取招聘来源', async () => {
    const store = fixture();

    await expect(runAs(store, () => store.service.createFromOffer(
      'offer-001',
      'onboarding-create-denied',
    ), { scopes: [] })).rejects.toMatchObject({
      response: { code: 'ONBOARDING_SCOPE_REQUIRED' },
    });

    expect(store.recruitment.getOnboardingSource).not.toHaveBeenCalled();
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('创建在部门范围外不得开始本地事务', async () => {
    const store = fixture();
    await expect(runAs(store, () => store.service.createFromOffer(
      'offer-001',
      'onboarding-create-department-denied',
    ), {
      scopes: ['erp:onboarding:create'],
      departmentIds: ['department-other'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_WRITE_DENIED' } });

    expect(store.recruitment.getOnboardingSource).toHaveBeenCalledWith('offer-001');
    expect(store.idempotency.execute).not.toHaveBeenCalled();
    expect(store.instances.insert).not.toHaveBeenCalled();
  });

  it('创建重放复用同一实例，并补偿推进招聘 preboarding', async () => {
    const current = inProgressInstance();
    const store = fixture(current);

    const result = await runAs(store, () => store.service.createFromOffer(
      'offer-001',
      'onboarding-create-replay',
    ));

    expect(result.onboarding.id).toBe(current.id);
    expect(store.instances.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
    expect(store.recruitment.markPreboarding).toHaveBeenCalledWith(
      expect.stringMatching(/^onboarding:/),
      { offerId: 'offer-001', onboardingInstanceId: current.id },
    );
  });

  it('创建带可信签署证据的实例时同步固化任务证据与事件', async () => {
    const store = fixture();

    const result = await runAs(store, () => store.service.createFromOffer(
      'offer-001',
      'onboarding-create-signed',
    ));

    expect(store.evidence.append).toHaveBeenCalledWith(expect.objectContaining({
      onboardingInstanceId: result.onboarding.id,
      taskCode: 'contract_archived',
      evidenceId: source.signedEvidenceId,
      actorId: 'onboarding-worker',
    }), SESSION);
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['offerId', 'offer-other'],
    ['applicationId', 'application-other'],
    ['candidateId', 'candidate-other'],
    ['acceptanceEvidenceId', 'acceptance-other'],
    ['departmentId', 'department-other'],
    ['jobLevelId', 'level-other'],
    ['proposedStartDate', '2026-08-02'],
  ] as const)('创建重放拒绝招聘来源字段 %s 漂移', async (field, value) => {
    const store = fixture(inProgressInstance());
    store.recruitment.getOnboardingSource.mockResolvedValue({
      ...source,
      [field]: value,
    });

    await expect(runAs(store, () => store.service.createFromOffer(
      'offer-001',
      `onboarding-source-mismatch-${field}`,
    ))).rejects.toMatchObject({ response: { code: 'ONBOARDING_SOURCE_MISMATCH' } });
    expect(store.recruitment.markPreboarding).not.toHaveBeenCalled();
  });

  it('创建重放拒绝既有签署证据引用漂移', async () => {
    const store = fixture(inProgressInstance('signed-evidence-original'));
    store.recruitment.getOnboardingSource.mockResolvedValue({
      ...source,
      signedEvidenceId: 'signed-evidence-other',
    });

    await expect(runAs(store, () => store.service.createFromOffer(
      'offer-001',
      'onboarding-signed-evidence-mismatch',
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_SIGNED_EVIDENCE_MISMATCH' },
    });
  });

  it.each([
    ['contract_archived', 'erp:onboarding:contract:attest'],
    ['identity_verified', 'erp:identity:onboarding:attest'],
    ['mandatory_training_completed', 'erp:knowledge:onboarding:attest'],
    ['materials_verified', 'erp:onboarding:task:complete'],
  ] as const)('任务 %s 必须由专用 Scope 证明', async (taskCode, requiredScope) => {
    const store = fixture(inProgressInstance());
    const scopes = store.trusted.actor.scopes.filter((scope) => scope !== requiredScope);

    await expect(runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      1,
      `onboarding-task-scope-${taskCode}`,
      { taskCode, evidenceId: `${taskCode}-evidence` },
    ), { scopes })).rejects.toMatchObject({
      response: { code: 'ONBOARDING_SCOPE_REQUIRED' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('组织分配必须先通过部门写授权，再调用 Org 校验', async () => {
    const store = fixture(inProgressInstance());
    const scopes = store.trusted.actor.scopes.filter(
      (scope) => scope !== 'erp:onboarding:write_all',
    );

    await expect(runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      1,
      'onboarding-org-department-denied',
      {
        taskCode: 'org_assignment_verified',
        evidenceId: 'org-evidence-001',
        orgPositionId: 'org-position-001',
      },
    ), {
      scopes,
      departmentIds: ['department-other'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_WRITE_DENIED' } });

    expect(store.org.validateOnboardingAssignment).not.toHaveBeenCalled();
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('组织分配缺少正式岗位时失败关闭', async () => {
    const store = fixture(inProgressInstance());

    await expect(runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      1,
      'onboarding-org-position-missing',
      {
        taskCode: 'org_assignment_verified',
        evidenceId: 'org-evidence-001',
      },
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_COMPLETION_EVIDENCE_MISSING' },
    });
    expect(store.org.validateOnboardingAssignment).not.toHaveBeenCalled();
  });

  it('相同任务证据重放不重复写仓储与 Outbox', async () => {
    const recorded = recordOnboardingTaskEvidence(inProgressInstance(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      taskCode: 'materials_verified',
      evidenceId: 'materials-evidence-001',
      evidenceRecordId: 'materials-record-001',
      actorId: 'actor-001',
    }, NOW).instance;
    const store = fixture(recorded);

    const result = await runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      recorded.version,
      'onboarding-task-replay',
      {
        taskCode: 'materials_verified',
        evidenceId: 'materials-evidence-001',
      },
    ));

    expect(result.onboarding.version).toBe(recorded.version);
    expect(store.instances.replace).not.toHaveBeenCalled();
    expect(store.evidence.append).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    [new OnboardingWriteConflictError(), 'ONBOARDING_VERSION_CONFLICT'],
    [new OnboardingDomainError('ONBOARDING_TASK_EVIDENCE_IMMUTABLE', '证据不可替换'),
      'ONBOARDING_TASK_EVIDENCE_IMMUTABLE'],
    [new OnboardingDomainError('ONBOARDING_CROSS_TENANT', '跨租户'),
      'ONBOARDING_CROSS_TENANT'],
    [new OnboardingDomainError('ONBOARDING_ID_INVALID', '标识非法'),
      'ONBOARDING_ID_INVALID'],
    [{ code: 11_000 }, 'ONBOARDING_UNIQUE_CONFLICT'],
  ])('应用异常映射为稳定契约 %#', async (failure, expectedCode) => {
    const store = fixture(inProgressInstance());
    store.idempotency.execute.mockRejectedValueOnce(failure);

    await expect(runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      1,
      `onboarding-error-${expectedCode}`,
      {
        taskCode: 'materials_verified',
        evidenceId: 'materials-evidence-001',
      },
    ))).rejects.toMatchObject({ response: { code: expectedCode } });
  });

  it('未知基础设施异常保持原始失败语义', async () => {
    const store = fixture(inProgressInstance());
    const failure = new Error('onboarding storage unavailable');
    store.idempotency.execute.mockRejectedValueOnce(failure);

    await expect(runAs(store, () => store.service.recordTaskEvidence(
      'onboarding-001',
      1,
      'onboarding-error-raw',
      {
        taskCode: 'materials_verified',
        evidenceId: 'materials-evidence-001',
      },
    ))).rejects.toBe(failure);
  });

  it('合同同步必须先通过部门写授权，再读取招聘来源', async () => {
    const store = fixture(inProgressInstance());
    const scopes = store.trusted.actor.scopes.filter(
      (scope) => scope !== 'erp:onboarding:write_all',
    );

    await expect(runAs(store, () => store.service.syncContractEvidence(
      'onboarding-001',
      1,
      'onboarding-contract-department-denied',
    ), {
      scopes,
      departmentIds: ['department-other'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_WRITE_DENIED' } });

    expect(store.recruitment.getOnboardingSource).not.toHaveBeenCalled();
  });

  it('合同同步在签署证据未归档时返回可恢复冲突', async () => {
    const store = fixture(inProgressInstance());
    store.recruitment.getOnboardingSource.mockResolvedValue({
      ...source,
      signedEvidenceId: null,
    });

    await expect(runAs(store, () => store.service.syncContractEvidence(
      'onboarding-001',
      1,
      'onboarding-contract-pending',
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_SIGNED_EVIDENCE_PENDING' },
    });
    expect(store.evidence.append).not.toHaveBeenCalled();
  });

  it('合同同步只写入招聘域返回的可信签署证据', async () => {
    const store = fixture(inProgressInstance());

    const result = await runAs(store, () => store.service.syncContractEvidence(
      'onboarding-001',
      1,
      'onboarding-contract-sync',
    ));

    expect(result.onboarding.tasks.contract_archived).toBe('completed');
    expect(store.evidence.append).toHaveBeenCalledWith(expect.objectContaining({
      taskCode: 'contract_archived',
      evidenceId: source.signedEvidenceId,
    }), SESSION);
  });

  it('完成 Saga 在缺少 Scope 或部门范围时不得推进外部系统', async () => {
    const current = readyInstance();
    const scopeStore = fixture(current);
    await expect(runAs(scopeStore, () => scopeStore.service.complete(
      current.id,
      current.version,
      'onboarding-complete-scope-denied',
    ), { scopes: [] })).rejects.toMatchObject({
      response: { code: 'ONBOARDING_SCOPE_REQUIRED' },
    });
    expect(scopeStore.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();

    const departmentStore = fixture(current);
    const scopes = departmentStore.trusted.actor.scopes.filter(
      (scope) => scope !== 'erp:onboarding:write_all',
    );
    await expect(runAs(departmentStore, () => departmentStore.service.complete(
      current.id,
      current.version,
      'onboarding-complete-department-denied',
    ), {
      scopes,
      departmentIds: ['department-other'],
    })).rejects.toMatchObject({ response: { code: 'ONBOARDING_WRITE_DENIED' } });
    expect(departmentStore.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();
  });

  it('provisioning 重试只接受当前版或 Saga 初始前一版', async () => {
    const invalid = provisioningInstance();
    const invalidStore = fixture(invalid);
    await expect(runAs(invalidStore, () => invalidStore.service.complete(
      invalid.id,
      invalid.version - 2,
      'onboarding-provisioning-stale',
    ))).rejects.toMatchObject({ response: { code: 'ONBOARDING_VERSION_CONFLICT' } });
    expect(invalidStore.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();

    for (const expectedVersion of [invalid.version, invalid.version - 1]) {
      const store = fixture(provisioningInstance());
      const result = await runAs(store, () => store.service.complete(
        invalid.id,
        expectedVersion,
        `onboarding-provisioning-retry-${expectedVersion}`,
      ));
      expect(result.onboarding.status).toBe('completed');
      expect(store.recruitment.markHired).toHaveBeenCalled();
    }
  });

  it('已完成 Saga 只接受当前、前一版或初始前两版恢复窗口', async () => {
    const completed = completedInstance();
    const staleStore = fixture(completed);
    await expect(runAs(staleStore, () => staleStore.service.complete(
      completed.id,
      completed.version - 3,
      'onboarding-completed-stale',
    ))).rejects.toMatchObject({ response: { code: 'ONBOARDING_VERSION_CONFLICT' } });
    expect(staleStore.recruitment.markHired).not.toHaveBeenCalled();

    for (const expectedVersion of [
      completed.version,
      completed.version - 1,
      completed.version - 2,
    ]) {
      const store = fixture(completed);
      const result = await runAs(store, () => store.service.complete(
        completed.id,
        expectedVersion,
        `onboarding-completed-retry-${expectedVersion}`,
      ));
      expect(result.onboarding.status).toBe('completed');
      expect(store.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();
      expect(store.recruitment.markHired).toHaveBeenCalledWith(
        expect.stringMatching(/^onboarding:/),
        expect.objectContaining({ employmentId: 'employment-001' }),
      );
    }
  });

  it('未就绪实例不能通过完成接口越过任务门禁', async () => {
    const store = fixture(inProgressInstance());

    await expect(runAs(store, () => store.service.complete(
      'onboarding-001',
      1,
      'onboarding-not-ready',
    ))).rejects.toMatchObject({ response: { code: 'ONBOARDING_NOT_COMPLETED' } });
    expect(store.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();
    expect(store.recruitment.markHired).not.toHaveBeenCalled();
  });

  it('provisioning 缺少任一关键证据时禁止建立劳动关系', async () => {
    const current = Object.freeze({
      ...provisioningInstance(),
      identityEvidenceId: null,
    });
    const store = fixture(current);

    await expect(runAs(store, () => store.service.complete(
      current.id,
      current.version,
      'onboarding-completion-evidence-missing',
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_COMPLETION_EVIDENCE_MISSING' },
    });
    expect(store.org.establishEmploymentFromOnboarding).not.toHaveBeenCalled();
  });

  it('外部建档成功后发现同一 Employment 已完成时幂等收敛', async () => {
    const provisioning = provisioningInstance();
    const completed = completeOnboardingProvisioning(provisioning, {
      tenantId: provisioning.tenantId,
      expectedVersion: provisioning.version,
      completionEvidenceId: provisioning.completionEvidenceId ?? '',
      employmentId: 'employment-001',
    }, NOW);
    const store = fixture(provisioning);
    store.instances.findById
      .mockResolvedValueOnce(provisioning)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed);

    const result = await runAs(store, () => store.service.complete(
      provisioning.id,
      provisioning.version,
      'onboarding-finish-replay',
    ));

    expect(result.onboarding.employmentId).toBe('employment-001');
    expect(store.instances.replace).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
    expect(store.recruitment.markHired).toHaveBeenCalled();
  });

  it('外部建档返回值与已完成实例不一致时失败关闭', async () => {
    const provisioning = provisioningInstance();
    const completed = completeOnboardingProvisioning(provisioning, {
      tenantId: provisioning.tenantId,
      expectedVersion: provisioning.version,
      completionEvidenceId: provisioning.completionEvidenceId ?? '',
      employmentId: 'employment-other',
    }, NOW);
    const store = fixture(provisioning);
    store.instances.findById
      .mockResolvedValueOnce(provisioning)
      .mockResolvedValueOnce(completed);

    await expect(runAs(store, () => store.service.complete(
      provisioning.id,
      provisioning.version,
      'onboarding-employment-mismatch',
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_EMPLOYMENT_MISMATCH' },
    });
    expect(store.recruitment.markHired).not.toHaveBeenCalled();
  });

  it('已完成实例缺少完成证据时禁止推进招聘 hired', async () => {
    const damaged = Object.freeze({
      ...completedInstance(),
      completionEvidenceId: null,
    });
    const store = fixture(damaged);

    await expect(runAs(store, () => store.service.complete(
      damaged.id,
      damaged.version,
      'onboarding-completed-damaged',
    ))).rejects.toMatchObject({
      response: { code: 'ONBOARDING_COMPLETION_EVIDENCE_MISSING' },
    });
    expect(store.recruitment.markHired).not.toHaveBeenCalled();
  });
});
