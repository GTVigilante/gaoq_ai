import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  beginOnboardingProvisioning,
  completeOnboardingProvisioning,
  createOnboardingInstance,
  recordOnboardingTaskEvidence,
  type OnboardingInstance,
  type OnboardingTaskCode,
  type OnboardingTaskEvidence,
} from '../domain/index.js';
import {
  OnboardingInstanceRepository,
  OnboardingTaskEvidenceRepository,
  OnboardingWriteConflictError,
} from './onboarding.repositories.js';
import type {
  OnboardingInstanceDocument,
  OnboardingTaskEvidenceDocument,
} from './onboarding.schemas.js';

const NOW = new Date('2026-07-29T01:00:00.000Z');
const LATER = new Date('2026-07-29T02:00:00.000Z');
const ACTIVE_SESSION = {
  inTransaction: vi.fn().mockReturnValue(true),
} as unknown as ClientSession;

function context(tenant: unknown = { tenantId: 'tenant-001' }): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue(tenant),
  } as unknown as TenantContextService;
}

function throwingContext(): TenantContextService {
  return {
    getTenantRequired: vi.fn(() => {
      throw new Error('上下文不可用');
    }),
  } as unknown as TenantContextService;
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    select: vi.fn(),
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.select.mockReturnValue(value);
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.limit.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function instanceModelHarness() {
  let one: unknown = null;
  let many: unknown = [];
  const queries: ReturnType<typeof query>[] = [];
  const model = {
    findOne: vi.fn().mockImplementation(() => {
      const current = query(() => one);
      queries.push(current);
      return current;
    }),
    find: vi.fn().mockImplementation(() => {
      const current = query(() => many);
      queries.push(current);
      return current;
    }),
    create: vi.fn().mockImplementation((rows: unknown) => Promise.resolve(rows)),
    updateOne: vi.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    }),
  };
  return {
    model,
    queries,
    setOne(value: unknown) {
      one = value;
    },
    setMany(value: unknown) {
      many = value;
    },
  };
}

function evidenceModelHarness() {
  const model = {
    create: vi.fn().mockImplementation((rows: unknown) => Promise.resolve(rows)),
  };
  return { model };
}

function baseInstance(overrides: Partial<OnboardingInstance> = {}): OnboardingInstance {
  return Object.freeze({
    ...createOnboardingInstance({
      id: 'onboarding-001',
      tenantId: 'tenant-001',
      offerId: 'offer-001',
      applicationId: 'application-001',
      candidateId: 'candidate-001',
      acceptanceEvidenceId: 'acceptance-001',
      signedEvidenceId: null,
      departmentId: 'department-001',
      jobLevelId: 'level-001',
      proposedStartDate: '2026-08-01',
    }, NOW),
    ...overrides,
  });
}

function readyInstance(): OnboardingInstance {
  let current = baseInstance();
  for (const taskCode of [
    'contract_archived',
    'identity_verified',
    'materials_verified',
    'org_assignment_verified',
    'mandatory_training_completed',
  ] as const) {
    current = recordOnboardingTaskEvidence(current, {
      tenantId: 'tenant-001',
      expectedVersion: current.version,
      taskCode,
      evidenceId: `${taskCode}-evidence`,
      evidenceRecordId: `${taskCode}-record`,
      actorId: 'actor-001',
      ...(taskCode === 'org_assignment_verified'
        ? { orgPositionId: 'org-position-001' }
        : {}),
    }, LATER).instance;
  }
  return current;
}

function provisioningInstance(): OnboardingInstance {
  const current = readyInstance();
  return beginOnboardingProvisioning(current, {
    tenantId: current.tenantId,
    expectedVersion: current.version,
    completionEvidenceId: 'completion-001',
  }, LATER);
}

function completedInstance(): OnboardingInstance {
  const current = provisioningInstance();
  return completeOnboardingProvisioning(current, {
    tenantId: current.tenantId,
    expectedVersion: current.version,
    completionEvidenceId: 'completion-001',
    employmentId: 'employment-001',
  }, LATER);
}

function instanceRecord(
  instance: OnboardingInstance = baseInstance(),
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...instance,
    createdAt: new Date(instance.createdAt),
    updatedAt: new Date(instance.updatedAt),
    ...overrides,
  };
}

function taskEvidence(
  overrides: Partial<OnboardingTaskEvidence> = {},
): OnboardingTaskEvidence {
  return Object.freeze({
    id: 'evidence-record-001',
    tenantId: 'tenant-001',
    onboardingInstanceId: 'onboarding-001',
    taskCode: 'identity_verified',
    evidenceId: 'identity-evidence-001',
    actorId: 'actor-001',
    occurredAt: '2026-07-29T02:00:00.000Z',
    ...overrides,
  });
}

function instanceRepository(
  harness = instanceModelHarness(),
  tenantContext: TenantContextService = context(),
) {
  return {
    harness,
    value: new OnboardingInstanceRepository(
      tenantContext,
      harness.model as unknown as Model<OnboardingInstanceDocument>,
    ),
  };
}

function evidenceRepository(
  harness = evidenceModelHarness(),
  tenantContext: TenantContextService = context(),
) {
  return {
    harness,
    value: new OnboardingTaskEvidenceRepository(
      tenantContext,
      harness.model as unknown as Model<OnboardingTaskEvidenceDocument>,
    ),
  };
}

describe('OnboardingInstanceRepository 可信读取', () => {
  it('按可信租户和实例标识读取固定投影，不存在时返回空值', async () => {
    const fixture = instanceRepository();

    await expect(fixture.value.findById('onboarding-001')).resolves.toBeNull();

    expect(fixture.harness.model.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: 'onboarding-001',
    });
    expect(fixture.harness.queries[0]?.select).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 0, tenantId: 1, employmentId: 1 }),
    );
    expect(fixture.harness.queries[0]?.session).not.toHaveBeenCalled();
  });

  it('事务读取绑定会话并返回冻结的规范领域对象', async () => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord());

    const result = await fixture.value.findById('onboarding-001', ACTIVE_SESSION);

    expect(result).toEqual(baseInstance());
    expect(Object.isFrozen(result)).toBe(true);
    expect(fixture.harness.queries[0]?.session).toHaveBeenCalledWith(ACTIVE_SESSION);
  });

  it('按 Offer 查询时同时反向绑定可信租户和 Offer', async () => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord());

    await expect(fixture.value.findByOfferId('offer-001')).resolves.toMatchObject({
      id: 'onboarding-001',
      offerId: 'offer-001',
    });
    expect(fixture.harness.model.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      offerId: 'offer-001',
    });
  });

  it('候选人时间线使用稳定顺序、一百条上限并冻结结果', async () => {
    const first = baseInstance({
      id: 'onboarding-002',
      offerId: 'offer-002',
      applicationId: 'application-002',
      createdAt: '2026-07-30T01:00:00.000Z',
      updatedAt: '2026-07-30T01:00:00.000Z',
    });
    const fixture = instanceRepository();
    fixture.harness.setMany([instanceRecord(first), instanceRecord()]);

    const result = await fixture.value.findByCandidateId('candidate-001');

    expect(result.map((item) => item.id)).toEqual(['onboarding-002', 'onboarding-001']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fixture.harness.model.find).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      candidateId: 'candidate-001',
    });
    expect(fixture.harness.queries[0]?.sort).toHaveBeenCalledWith({
      createdAt: -1,
      id: 1,
    });
    expect(fixture.harness.queries[0]?.limit).toHaveBeenCalledWith(100);
  });

  it.each([
    ['findById', ''],
    ['findById', ' leading-space'],
    ['findByOfferId', 'offer/001'],
    ['findByCandidateId', '候选人-001'],
    ['findByCandidateId', 'x'.repeat(129)],
  ] as const)('%s 在数据库调用前拒绝非规范标识：%s', async (method, id) => {
    const fixture = instanceRepository();

    await expect(fixture.value[method](id)).rejects.toThrow(
      'ONBOARDING_REPOSITORY_INPUT_INVALID',
    );
    expect(fixture.harness.model.findOne).not.toHaveBeenCalled();
    expect(fixture.harness.model.find).not.toHaveBeenCalled();
  });

  it.each([
    context(null),
    context({}),
    context({ tenantId: '' }),
    context({ tenantId: 'tenant/001' }),
    throwingContext(),
  ])('可信租户上下文缺失或损坏时失败关闭', async (tenantContext) => {
    const fixture = instanceRepository(instanceModelHarness(), tenantContext);

    await expect(fixture.value.findById('onboarding-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_CONTEXT_INVALID',
    );
    expect(fixture.harness.model.findOne).not.toHaveBeenCalled();
  });

  it.each([
    { tenantId: 'tenant-evil' },
    { id: 'onboarding-evil' },
  ])('按主键读取时拒绝错绑记录：%o', async (overrides) => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord(baseInstance(), overrides));

    await expect(fixture.value.findById('onboarding-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });

  it('按 Offer 读取时拒绝返回其他 Offer 的记录', async () => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord(baseInstance(), { offerId: 'offer-evil' }));

    await expect(fixture.value.findByOfferId('offer-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });

  it('候选人时间线拒绝返回其他候选人的记录', async () => {
    const fixture = instanceRepository();
    fixture.harness.setMany([
      instanceRecord(baseInstance(), { candidateId: 'candidate-evil' }),
    ]);

    await expect(fixture.value.findByCandidateId('candidate-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });

  it.each([
    { unexpected: true },
    { status: 'self_reported' },
    { version: 0 },
    { proposedStartDate: '2026-02-30' },
    { createdAt: new Date('invalid') },
    { updatedAt: '2026-07-29T02:00:00.000Z' },
    { signedEvidenceId: 'signed/evidence' },
  ])('拒绝字段、类型或值受损的实例记录：%o', async (overrides) => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord(baseInstance(), overrides));

    await expect(fixture.value.findById('onboarding-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });

  it.each([
    {
      orgAssignmentEvidenceId: 'org-evidence-001',
      orgPositionId: null,
      version: 2,
    },
    {
      orgAssignmentEvidenceId: null,
      orgPositionId: 'org-position-001',
      version: 1,
    },
    {
      createdAt: new Date('2026-07-29T03:00:00.000Z'),
      updatedAt: new Date('2026-07-29T02:00:00.000Z'),
    },
    {
      ...instanceRecord(readyInstance()),
      status: 'in_progress',
    },
    {
      ...instanceRecord(baseInstance()),
      status: 'ready',
    },
    {
      ...instanceRecord(readyInstance()),
      status: 'ready',
      completionEvidenceId: 'completion-001',
    },
    {
      ...instanceRecord(readyInstance()),
      status: 'provisioning',
      completionEvidenceId: null,
      version: 7,
    },
    {
      ...instanceRecord(provisioningInstance()),
      employmentId: 'employment-001',
    },
    {
      ...instanceRecord(provisioningInstance()),
      version: 5,
    },
    {
      ...instanceRecord(completedInstance()),
      employmentId: null,
    },
    {
      ...instanceRecord(completedInstance()),
      completionEvidenceId: null,
    },
    {
      ...instanceRecord(completedInstance()),
      version: 6,
    },
    {
      status: 'cancelled',
      completionEvidenceId: 'completion-001',
      version: 2,
    },
    {
      status: 'cancelled',
      employmentId: 'employment-001',
      version: 2,
    },
    {
      identityEvidenceId: 'identity-evidence-001',
      version: 4,
    },
  ])('拒绝状态、证据、版本或时间不闭合的实例记录：%o', async (overrides) => {
    const fixture = instanceRepository();
    const value = 'id' in overrides
      ? overrides
      : instanceRecord(baseInstance(), overrides);
    fixture.harness.setOne(value);

    await expect(fixture.value.findById('onboarding-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });

  it('接受已取消且未绑定完成证明或劳动关系的受控终态', async () => {
    const fixture = instanceRepository();
    fixture.harness.setOne(instanceRecord(baseInstance({
      status: 'cancelled',
      version: 2,
      updatedAt: '2026-07-29T02:00:00.000Z',
    })));

    await expect(fixture.value.findById('onboarding-001')).resolves.toMatchObject({
      status: 'cancelled',
      employmentId: null,
    });
  });

  it.each([
    {
      values: [
        instanceRecord(baseInstance()),
        instanceRecord(baseInstance()),
      ],
      name: '重复实例标识',
    },
    {
      values: [
        instanceRecord(baseInstance()),
        instanceRecord(baseInstance({
          id: 'onboarding-002',
          offerId: 'offer-002',
          applicationId: 'application-002',
          createdAt: '2026-07-30T01:00:00.000Z',
          updatedAt: '2026-07-30T01:00:00.000Z',
        })),
      ],
      name: '时间降序错位',
    },
    {
      values: [
        instanceRecord(baseInstance({
          id: 'onboarding-002',
          offerId: 'offer-002',
          applicationId: 'application-002',
        })),
        instanceRecord(baseInstance()),
      ],
      name: '同时间标识升序错位',
    },
    {
      values: 'not-an-array',
      name: '非数组回执',
    },
    {
      values: Array.from({ length: 101 }, (_, index) => instanceRecord(baseInstance({
        id: `onboarding-${String(index).padStart(3, '0')}`,
        offerId: `offer-${String(index).padStart(3, '0')}`,
        applicationId: `application-${String(index).padStart(3, '0')}`,
      }))),
      name: '超出有界结果集',
    },
  ])('候选人时间线拒绝$name', async ({ values }) => {
    const fixture = instanceRepository();
    fixture.harness.setMany(values);

    await expect(fixture.value.findByCandidateId('candidate-001')).rejects.toThrow(
      'ONBOARDING_REPOSITORY_RECORD_INVALID',
    );
  });
});

describe('OnboardingInstanceRepository 事务写入', () => {
  it.each([
    baseInstance(),
    readyInstance(),
    provisioningInstance(),
    completedInstance(),
  ])('在活动事务中插入并反向绑定数据库创建回执：$status', async (instance) => {
    const fixture = instanceRepository();

    await expect(fixture.value.insert(instance, ACTIVE_SESSION)).resolves.toBeUndefined();

    const rows = fixture.harness.model.create.mock.calls[0]?.[0] as
      readonly Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: instance.id,
      tenantId: instance.tenantId,
      status: instance.status,
      version: instance.version,
      createdAt: new Date(instance.createdAt),
      updatedAt: new Date(instance.updatedAt),
    });
    expect(fixture.harness.model.create).toHaveBeenCalledWith(rows, {
      session: ACTIVE_SESSION,
    });
  });

  it.each([
    baseInstance({ tenantId: 'tenant-evil' }),
    { ...baseInstance(), unexpected: true } as unknown as OnboardingInstance,
    baseInstance({ id: 'onboarding/001' }),
    baseInstance({ status: 'ready' }),
    baseInstance({ createdAt: 'not-an-instant' }),
  ])('插入前拒绝跨租户或非法领域对象', async (instance) => {
    const fixture = instanceRepository();

    await expect(fixture.value.insert(instance, ACTIVE_SESSION)).rejects.toThrow();
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { inTransaction: true },
    { inTransaction: vi.fn().mockReturnValue(false) },
    {
      inTransaction: vi.fn(() => {
        throw new Error('session closed');
      }),
    },
  ])('插入要求活动 Mongo 事务：%o', async (sessionValue) => {
    const fixture = instanceRepository();

    await expect(fixture.value.insert(
      baseInstance(),
      sessionValue as unknown as ClientSession,
    )).rejects.toThrow('ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED');
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    [],
    [instanceRecord(), instanceRecord()],
    [instanceRecord(baseInstance(), { tenantId: 'tenant-evil' })],
    [instanceRecord(baseInstance(), { status: 'completed' })],
    [null],
  ])('插入后拒绝缺失、错绑或非法数据库回执：%o', async (created) => {
    const harness = instanceModelHarness();
    harness.model.create.mockResolvedValueOnce(created);
    const fixture = instanceRepository(harness);

    await expect(fixture.value.insert(baseInstance(), ACTIVE_SESSION)).rejects.toThrow(
      'ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE',
    );
  });

  it('数据库插入异常保留给事务上层分类', async () => {
    const harness = instanceModelHarness();
    const databaseError = new Error('database unavailable');
    harness.model.create.mockRejectedValueOnce(databaseError);
    const fixture = instanceRepository(harness);

    await expect(fixture.value.insert(baseInstance(), ACTIVE_SESSION)).rejects.toBe(databaseError);
  });

  it('更新绑定全部不可变引用、预期版本和活动事务', async () => {
    const fixture = instanceRepository();
    const next = baseInstance({
      identityEvidenceId: 'identity-evidence-001',
      version: 2,
      updatedAt: '2026-07-29T02:00:00.000Z',
    });

    await expect(fixture.value.replace(next, 1, ACTIVE_SESSION)).resolves.toBeUndefined();

    expect(fixture.harness.model.updateOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-001',
        id: 'onboarding-001',
        version: 1,
        offerId: 'offer-001',
        applicationId: 'application-001',
        candidateId: 'candidate-001',
        acceptanceEvidenceId: 'acceptance-001',
        departmentId: 'department-001',
        jobLevelId: 'level-001',
        proposedStartDate: '2026-08-01',
        createdAt: new Date('2026-07-29T01:00:00.000Z'),
      },
      { $set: {
        signedEvidenceId: null,
        identityEvidenceId: 'identity-evidence-001',
        materialsEvidenceId: null,
        orgAssignmentEvidenceId: null,
        trainingEvidenceId: null,
        orgPositionId: null,
        status: 'in_progress',
        completionEvidenceId: null,
        employmentId: null,
        version: 2,
        updatedAt: new Date('2026-07-29T02:00:00.000Z'),
      } },
      { session: ACTIVE_SESSION, timestamps: false, runValidators: true },
    );
  });

  it.each([
    {
      instance: baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      expectedVersion: 0,
    },
    {
      instance: baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      expectedVersion: 2,
    },
    {
      instance: baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      expectedVersion: 1.5,
    },
    {
      instance: baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      expectedVersion: Number.MAX_SAFE_INTEGER,
    },
    {
      instance: baseInstance({
        tenantId: 'tenant-evil',
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      expectedVersion: 1,
    },
  ])('更新前拒绝非法版本或跨租户对象：%o', async ({ instance, expectedVersion }) => {
    const fixture = instanceRepository();

    await expect(fixture.value.replace(
      instance,
      expectedVersion,
      ACTIVE_SESSION,
    )).rejects.toThrow();
    expect(fixture.harness.model.updateOne).not.toHaveBeenCalled();
  });

  it('更新要求活动事务', async () => {
    const fixture = instanceRepository();

    await expect(fixture.value.replace(
      baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      1,
      { inTransaction: vi.fn().mockReturnValue(false) } as unknown as ClientSession,
    )).rejects.toThrow('ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED');
    expect(fixture.harness.model.updateOne).not.toHaveBeenCalled();
  });

  it('乐观锁未命中时抛出稳定冲突类型', async () => {
    const harness = instanceModelHarness();
    harness.model.updateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
    });
    const fixture = instanceRepository(harness);

    await expect(fixture.value.replace(
      baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      1,
      ACTIVE_SESSION,
    )).rejects.toBeInstanceOf(OnboardingWriteConflictError);
  });

  it.each([
    null,
    {},
    { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
    { acknowledged: true, matchedCount: 2, modifiedCount: 2 },
    { acknowledged: true, matchedCount: '1', modifiedCount: 1 },
  ])('更新拒绝异常数据库写回：%o', async (result) => {
    const harness = instanceModelHarness();
    harness.model.updateOne.mockResolvedValueOnce(result);
    const fixture = instanceRepository(harness);

    await expect(fixture.value.replace(
      baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      1,
      ACTIVE_SESSION,
    )).rejects.toThrow('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
  });

  it('数据库更新异常保留给事务上层分类', async () => {
    const harness = instanceModelHarness();
    const databaseError = new Error('database unavailable');
    harness.model.updateOne.mockRejectedValueOnce(databaseError);
    const fixture = instanceRepository(harness);

    await expect(fixture.value.replace(
      baseInstance({
        identityEvidenceId: 'identity-evidence-001',
        version: 2,
        updatedAt: '2026-07-29T02:00:00.000Z',
      }),
      1,
      ACTIVE_SESSION,
    )).rejects.toBe(databaseError);
  });
});

describe('OnboardingTaskEvidenceRepository', () => {
  it.each([
    'contract_archived',
    'identity_verified',
    'materials_verified',
    'org_assignment_verified',
    'mandatory_training_completed',
  ] as const)('在活动事务中追加并反向绑定 %s 证明', async (taskCode) => {
    const fixture = evidenceRepository();
    const evidence = taskEvidence({ taskCode });

    await expect(fixture.value.append(evidence, ACTIVE_SESSION)).resolves.toBeUndefined();

    const rows = fixture.harness.model.create.mock.calls[0]?.[0] as
      readonly Record<string, unknown>[];
    expect(rows).toEqual([{
      ...evidence,
      occurredAt: new Date(evidence.occurredAt),
    }]);
    expect(fixture.harness.model.create).toHaveBeenCalledWith(rows, {
      session: ACTIVE_SESSION,
    });
  });

  it.each([
    taskEvidence({ tenantId: 'tenant-evil' }),
    taskEvidence({ id: 'evidence/001' }),
    taskEvidence({ taskCode: 'self_reported' as OnboardingTaskCode }),
    taskEvidence({ occurredAt: '2026-07-29T02:00:00Z' }),
    { ...taskEvidence(), unexpected: true } as unknown as OnboardingTaskEvidence,
  ])('追加前拒绝跨租户或非法证明：%o', async (evidence) => {
    const fixture = evidenceRepository();

    await expect(fixture.value.append(evidence, ACTIVE_SESSION)).rejects.toThrow();
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it.each([
    context(null),
    context({ tenantId: '' }),
    context({ tenantId: 'tenant/001' }),
    throwingContext(),
  ])('证明仓储拒绝缺失或损坏的可信租户上下文', async (tenantContext) => {
    const fixture = evidenceRepository(evidenceModelHarness(), tenantContext);

    await expect(fixture.value.append(
      taskEvidence(),
      ACTIVE_SESSION,
    )).rejects.toThrow('ONBOARDING_EVIDENCE_CONTEXT_INVALID');
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it('证明追加要求活动 Mongo 事务', async () => {
    const fixture = evidenceRepository();

    await expect(fixture.value.append(
      taskEvidence(),
      { inTransaction: vi.fn().mockReturnValue(false) } as unknown as ClientSession,
    )).rejects.toThrow('ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED');
    expect(fixture.harness.model.create).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    [],
    [null],
    [{
      ...taskEvidence(),
      tenantId: 'tenant-evil',
      occurredAt: new Date('2026-07-29T02:00:00.000Z'),
    }],
    [{
      ...taskEvidence(),
      occurredAt: new Date('invalid'),
    }],
    [
      {
        ...taskEvidence(),
        occurredAt: new Date('2026-07-29T02:00:00.000Z'),
      },
      {
        ...taskEvidence(),
        occurredAt: new Date('2026-07-29T02:00:00.000Z'),
      },
    ],
  ])('证明追加拒绝缺失、错绑或非法数据库回执：%o', async (created) => {
    const harness = evidenceModelHarness();
    harness.model.create.mockResolvedValueOnce(created);
    const fixture = evidenceRepository(harness);

    await expect(fixture.value.append(
      taskEvidence(),
      ACTIVE_SESSION,
    )).rejects.toThrow('ONBOARDING_EVIDENCE_WRITE_UNAVAILABLE');
  });

  it('证明数据库异常保留给事务上层分类', async () => {
    const harness = evidenceModelHarness();
    const databaseError = new Error('database unavailable');
    harness.model.create.mockRejectedValueOnce(databaseError);
    const fixture = evidenceRepository(harness);

    await expect(fixture.value.append(
      taskEvidence(),
      ACTIVE_SESSION,
    )).rejects.toBe(databaseError);
  });
});
