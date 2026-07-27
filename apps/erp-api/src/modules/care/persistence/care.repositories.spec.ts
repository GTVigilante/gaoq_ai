import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AlumniCleanupTask,
  AlumniConsent,
  CareCase,
  CareOccasionPreference,
  CareOccasionTask,
  CareTaskEvidence,
} from '../domain/index.js';
import {
  CareAlumniCleanupTaskRepository,
  CareAlumniConsentRepository,
  CareCaseRepository,
  CareOccasionPreferenceRepository,
  CareOccasionTaskRepository,
  CareOccasionTenantRepository,
  CareTaskEvidenceRepository,
  CareWriteConflictError,
} from './care.repositories.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'user',
  actorId: 'care-operator',
  tenantId: tenant.tenantId,
  roleCodes: ['care_operator'],
  scopes: ['erp:care:write'],
  departmentIds: [],
  traceId: 'trace-care-repository',
};
const session = {} as ClientSession;
const NOW = new Date('2026-07-27T08:00:00.000Z');
const LATER = new Date('2026-07-28T08:00:00.000Z');

function query<T>(value: T) {
  const chain = {
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn(() => Promise.resolve(value)),
  };
  chain.session.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function context(): TenantContextService {
  return new TenantContextService();
}

function run<T>(tenantContext: TenantContextService, operation: () => T): T {
  return tenantContext.run({ tenant, actor }, operation);
}

function careCase(overrides: Partial<CareCase> = {}): CareCase {
  return {
    id: 'care-case-001',
    tenantId: tenant.tenantId,
    employeeId: 'employee-001',
    employmentId: 'employment-001',
    separationType: 'voluntary_resignation',
    reasonCode: 'PERSONAL_REASON',
    lastWorkingDate: '2026-07-31',
    tenantTimeZone: 'Asia/Shanghai',
    accessDisableAt: '2026-07-31T10:00:00.000Z',
    status: 'draft',
    approvalInstanceId: null,
    handoverEvidenceId: null,
    assetsEvidenceId: null,
    financeEvidenceId: null,
    retentionEvidenceId: null,
    executionEvidenceId: null,
    orgTerminationEvidenceId: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function careCaseRecord(overrides: Record<string, unknown> = {}) {
  const value = careCase();
  return {
    ...value,
    accessDisableAt: new Date(value.accessDisableAt),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    ...overrides,
  };
}

function consent(overrides: Partial<AlumniConsent> = {}): AlumniConsent {
  return {
    id: 'consent-001',
    tenantId: tenant.tenantId,
    personId: 'person-001',
    careCaseId: 'care-case-001',
    purpose: 'alumni_network',
    channels: ['email'],
    consentVersion: 'v1',
    consentEvidenceId: 'consent-evidence-001',
    grantedAt: NOW.toISOString(),
    expiresAt: '2027-07-27T08:00:00.000Z',
    withdrawnAt: null,
    expiredAt: null,
    status: 'active',
    version: 1,
    ...overrides,
  };
}

function consentRecord(overrides: Record<string, unknown> = {}) {
  const value = consent();
  return {
    ...value,
    channels: [...value.channels],
    grantedAt: new Date(value.grantedAt),
    expiresAt: new Date(value.expiresAt),
    withdrawnAt: null,
    expiredAt: null,
    ...overrides,
  };
}

function cleanupTask(overrides: Partial<AlumniCleanupTask> = {}): AlumniCleanupTask {
  return {
    id: 'cleanup-task-001',
    tenantId: tenant.tenantId,
    consentId: 'consent-001',
    consentVersion: 1,
    consentPurpose: 'alumni_network',
    terminationReason: 'withdrawn',
    terminatedAt: NOW.toISOString(),
    sourceEventId: 'source-event-001',
    targetCode: 'crm',
    policyVersion: 'cleanup-v1',
    controlDigest: 'c'.repeat(43),
    maxAttempts: 6,
    proofRetentionDays: 2555,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW.toISOString(),
    lockedAt: null,
    lockedBy: null,
    proofDigest: null,
    proofAction: null,
    proofStorage: null,
    proofCompletedAt: null,
    proofRetentionUntil: null,
    proofKeyId: null,
    lastErrorCode: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function cleanupTaskRecord(overrides: Record<string, unknown> = {}) {
  const value = cleanupTask();
  return {
    ...value,
    terminatedAt: new Date(value.terminatedAt),
    nextAttemptAt: new Date(value.nextAttemptAt),
    lockedAt: null,
    proofCompletedAt: null,
    proofRetentionUntil: null,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    ...overrides,
  };
}

function preference(overrides: Partial<CareOccasionPreference> = {}): CareOccasionPreference {
  return {
    id: 'preference-001',
    tenantId: tenant.tenantId,
    personId: 'person-001',
    employeeId: 'employee-001',
    currentEmploymentId: 'employment-001',
    birthdayEnabled: true,
    anniversaryEnabled: true,
    preferredChannels: ['email'],
    unsubscribed: false,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function preferenceRecord(overrides: Record<string, unknown> = {}) {
  const value = preference();
  return {
    ...value,
    preferredChannels: [...value.preferredChannels],
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    ...overrides,
  };
}

function occasionTask(overrides: Partial<CareOccasionTask> = {}): CareOccasionTask {
  return {
    id: 'occasion-task-001',
    tenantId: tenant.tenantId,
    personId: 'person-001',
    employeeId: 'employee-001',
    employmentId: 'employment-001',
    occasionType: 'birthday',
    occurrenceYear: 2026,
    scheduledAt: NOW.toISOString(),
    templateCode: 'CARE_BIRTHDAY',
    policyVersion: 'occasion-v1',
    preferredChannels: ['email'],
    sourceDigest: 's'.repeat(43),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW.toISOString(),
    lockedAt: null,
    lockedBy: null,
    denialCode: null,
    deliveryEvidenceId: null,
    deliveredAt: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function occasionTaskRecord(overrides: Record<string, unknown> = {}) {
  const value = occasionTask();
  return {
    ...value,
    preferredChannels: [...value.preferredChannels],
    scheduledAt: new Date(value.scheduledAt),
    nextAttemptAt: new Date(value.nextAttemptAt),
    lockedAt: null,
    deliveredAt: null,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    ...overrides,
  };
}

describe('CareCaseRepository 与 CareTaskEvidenceRepository', () => {
  it('按可信租户读取、列举并转换离职关怀聚合', async () => {
    const tenantContext = context();
    const firstQuery = query(careCaseRecord());
    const findOne = vi.fn()
      .mockReturnValueOnce(firstQuery)
      .mockReturnValueOnce(query(null));
    const find = vi.fn().mockReturnValue(query([careCaseRecord()]));
    const repository = new CareCaseRepository(
      tenantContext,
      { findOne, find } as never,
    );
    const found = await run(tenantContext, () => repository.findById('care-case-001', session));
    expect(found).toEqual(careCase());
    expect(firstQuery.session).toHaveBeenCalledWith(session);
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () => repository.findByEmploymentIds([]))).resolves.toEqual([]);
    await expect(run(tenantContext, () =>
      repository.findByEmploymentIds(['employment-001']))).resolves.toEqual([careCase()]);
    expect(find).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      employmentId: { $in: ['employment-001'] },
    });
  });

  it('新增、替换和证据追加转换日期并拒绝跨租户及版本冲突', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CareCaseRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(careCase(), session));
    expect(JSON.stringify(create.mock.calls)).toContain(NOW.toISOString());
    expect(JSON.stringify(create.mock.calls)).toContain('2026-07-31T10:00:00.000Z');
    await run(tenantContext, () => repository.replace(
      careCase({ status: 'approved', version: 2 }),
      1,
      session,
    ));
    await expect(run(tenantContext, () => repository.replace(careCase(), 1, session)))
      .rejects.toBeInstanceOf(CareWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      careCase({ tenantId: 'tenant-other' }),
      session,
    ))).rejects.toThrow('拒绝跨租户实体');

    const evidenceCreate = vi.fn().mockResolvedValue([]);
    const evidenceRepository = new CareTaskEvidenceRepository(
      tenantContext,
      { create: evidenceCreate } as never,
    );
    const evidence: CareTaskEvidence = {
      id: 'evidence-001',
      tenantId: tenant.tenantId,
      careCaseId: 'care-case-001',
      taskCode: 'handover_accepted',
      evidenceId: 'worm-evidence-001',
      actorId: actor.actorId,
      occurredAt: NOW.toISOString(),
    };
    await run(tenantContext, () => evidenceRepository.append(evidence, session));
    expect(JSON.stringify(evidenceCreate.mock.calls)).toContain(NOW.toISOString());
    await expect(run(tenantContext, () => evidenceRepository.append(
      { ...evidence, tenantId: 'tenant-other' },
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('CareAlumniConsentRepository', () => {
  it('读取列表保留不可变渠道并转换可选终止时间', async () => {
    const tenantContext = context();
    const terminated = consentRecord({
      withdrawnAt: LATER,
      expiredAt: LATER,
      status: 'withdrawn',
      version: 2,
    });
    const findOne = vi.fn()
      .mockReturnValueOnce(query(consentRecord()))
      .mockReturnValueOnce(query(null));
    const find = vi.fn().mockReturnValue(query([terminated]));
    const repository = new CareAlumniConsentRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () => repository.findById('consent-001', session)))
      .resolves.toEqual(consent());
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () => repository.findByCareCaseIds([]))).resolves.toEqual([]);
    const values = await run(tenantContext, () =>
      repository.findByCareCaseIds(['care-case-001']));
    expect(values[0]).toMatchObject({
      withdrawnAt: LATER.toISOString(),
      expiredAt: LATER.toISOString(),
      status: 'withdrawn',
    });
  });

  it('新增和替换授权只接受本租户并检测并发冲突', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CareAlumniConsentRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(consent(), session));
    expect(JSON.stringify(create.mock.calls)).toContain('"withdrawnAt":null');
    expect(JSON.stringify(create.mock.calls)).toContain('"expiredAt":null');
    await run(tenantContext, () => repository.replace(consent(), 1, session));
    await run(tenantContext, () => repository.replace(consent({
      status: 'expired',
      expiredAt: LATER.toISOString(),
      withdrawnAt: LATER.toISOString(),
      version: 2,
    }), 1, session));
    expect(JSON.stringify(updateOne.mock.calls[1])).toContain(LATER.toISOString());
    await expect(run(tenantContext, () => repository.replace(consent(), 1, session)))
      .rejects.toBeInstanceOf(CareWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      consent({ tenantId: 'tenant-other' }),
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('CareAlumniCleanupTaskRepository', () => {
  it('读取、列表和认领任务时转换全部证明日期', async () => {
    const tenantContext = context();
    const completed = cleanupTaskRecord({
      status: 'completed',
      lockedAt: NOW,
      proofDigest: 'p'.repeat(43),
      proofAction: 'deleted',
      proofStorage: 'immutable_worm',
      proofCompletedAt: LATER,
      proofRetentionUntil: new Date('2033-07-27T08:00:00.000Z'),
      proofKeyId: 'proof-key-001',
    });
    const findOne = vi.fn()
      .mockReturnValueOnce(query(completed))
      .mockReturnValueOnce(query(null));
    const find = vi.fn().mockReturnValue(query([completed]));
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(query(completed))
      .mockReturnValueOnce(query(null));
    const repository = new CareAlumniCleanupTaskRepository(
      tenantContext,
      { findOne, find, findOneAndUpdate } as never,
    );
    const found = await run(tenantContext, () => repository.findById(
      'cleanup-task-001',
      session,
    ));
    expect(found).toMatchObject({
      lockedAt: NOW.toISOString(),
      proofCompletedAt: LATER.toISOString(),
      proofRetentionUntil: '2033-07-27T08:00:00.000Z',
    });
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () => repository.findByConsentId('consent-001')))
      .resolves.toHaveLength(1);
    await expect(run(tenantContext, () => repository.claim(
      'cleanup-task-001',
      'worker-001',
      NOW,
    ))).resolves.toMatchObject({ id: 'cleanup-task-001' });
    await expect(run(tenantContext, () => repository.claim(
      'cleanup-task-002',
      'worker-001',
      NOW,
    ))).resolves.toBeNull();
  });

  it('计划任务支持首次插入和相同控制摘要幂等复用', async () => {
    const tenantContext = context();
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ upsertedCount: 0 });
    const findOne = vi.fn().mockReturnValue(query(cleanupTaskRecord()));
    const repository = new CareAlumniCleanupTaskRepository(
      tenantContext,
      { updateOne, findOne } as never,
    );
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(cleanupTask(), session))).resolves.toBe(true);
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(cleanupTask(), session))).resolves.toBe(false);
    const insertCall = JSON.stringify(updateOne.mock.calls[0]);
    expect(insertCall).toContain('"lockedAt":null');
    expect(insertCall).toContain('"proofCompletedAt":null');
    expect(insertCall).toContain('"proofRetentionUntil":null');
  });

  it.each([
    null,
    cleanupTaskRecord({ controlDigest: 'x'.repeat(43) }),
    cleanupTaskRecord({ sourceEventId: 'source-event-other' }),
    cleanupTaskRecord({ policyVersion: 'cleanup-v2' }),
  ])('计划任务检测稳定控制字段冲突 %#', async (existing) => {
    const tenantContext = context();
    const repository = new CareAlumniCleanupTaskRepository(
      tenantContext,
      {
        updateOne: vi.fn().mockResolvedValue({ upsertedCount: 0 }),
        findOne: vi.fn().mockReturnValue(query(existing)),
      } as never,
    );
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(cleanupTask(), session)))
      .rejects.toBeInstanceOf(CareWriteConflictError);
  });

  it('替换已认领任务转换证明字段并拒绝跨租户及版本竞争', async () => {
    const tenantContext = context();
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CareAlumniCleanupTaskRepository(
      tenantContext,
      { updateOne } as never,
    );
    await run(tenantContext, () => repository.replaceClaimed(
      cleanupTask(),
      1,
      'worker-001',
      session,
    ));
    await run(tenantContext, () => repository.replaceClaimed(cleanupTask({
      status: 'completed',
      lockedAt: NOW.toISOString(),
      proofCompletedAt: LATER.toISOString(),
      proofRetentionUntil: '2033-07-27T08:00:00.000Z',
      version: 2,
    }), 1, 'worker-001', session));
    const completedCall = JSON.stringify(updateOne.mock.calls[1]);
    expect(completedCall).toContain(NOW.toISOString());
    expect(completedCall).toContain(LATER.toISOString());
    expect(completedCall).toContain('2033-07-27T08:00:00.000Z');
    await expect(run(tenantContext, () => repository.replaceClaimed(
      cleanupTask(),
      1,
      'worker-001',
      session,
    ))).rejects.toBeInstanceOf(CareWriteConflictError);
    await expect(run(tenantContext, () => repository.replaceClaimed(
      cleanupTask({ tenantId: 'tenant-other' }),
      1,
      'worker-001',
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('CareOccasionPreferenceRepository', () => {
  it('按员工读取、分页列举并转换关怀偏好', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(preferenceRecord()))
      .mockReturnValueOnce(query(null));
    const find = vi.fn()
      .mockReturnValueOnce(query([preferenceRecord()]))
      .mockReturnValueOnce(query([preferenceRecord()]));
    const repository = new CareOccasionPreferenceRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () => repository.findByEmployeeId(
      'employee-001',
      session,
    ))).resolves.toEqual(preference());
    await expect(run(tenantContext, () =>
      repository.findByEmployeeId('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findEnabled(null, 100))).resolves.toHaveLength(1);
    await expect(run(tenantContext, () =>
      repository.findEnabled('employee-000', 100))).resolves.toHaveLength(1);
    expect(find.mock.calls[0]?.[0]).not.toHaveProperty('employeeId');
    expect(find.mock.calls[1]?.[0]).toHaveProperty('employeeId.$gt', 'employee-000');
  });

  it('新增和替换偏好复制渠道并检测租户与版本冲突', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CareOccasionPreferenceRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(preference(), session));
    await run(tenantContext, () => repository.replace(
      preference({ preferredChannels: ['email', 'feishu'], version: 2 }),
      1,
      session,
    ));
    expect(JSON.stringify(create.mock.calls)).toContain(NOW.toISOString());
    await expect(run(tenantContext, () => repository.replace(
      preference(),
      1,
      session,
    ))).rejects.toBeInstanceOf(CareWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      preference({ tenantId: 'tenant-other' }),
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('CareOccasionTaskRepository', () => {
  it('读取和列表转换关怀任务日期及可选终态字段', async () => {
    const tenantContext = context();
    const delivered = occasionTaskRecord({
      status: 'delivered',
      lockedAt: NOW,
      deliveredAt: LATER,
      deliveryEvidenceId: 'delivery-evidence-001',
    });
    const findOne = vi.fn()
      .mockReturnValueOnce(query(delivered))
      .mockReturnValueOnce(query(null));
    const find = vi.fn().mockReturnValue(query([delivered]));
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findById('occasion-task-001', session))).resolves.toMatchObject({
      lockedAt: NOW.toISOString(),
      deliveredAt: LATER.toISOString(),
    });
    await expect(run(tenantContext, () => repository.findById('missing')))
      .resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findByEmployeeId('employee-001'))).resolves.toHaveLength(1);
  });

  it('计划任务覆盖新增、终态复用、相同计划复用、重开和并发冲突', async () => {
    const tenantContext = context();
    const terminal = occasionTaskRecord({ status: 'delivered' });
    const identical = occasionTaskRecord();
    const reopenable = occasionTaskRecord({
      status: 'cancelled',
      denialCode: 'unsubscribed',
    });
    const updated = occasionTaskRecord({
      policyVersion: 'occasion-v2',
      version: 2,
    });
    const findOne = vi.fn()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(terminal))
      .mockReturnValueOnce(query(identical))
      .mockReturnValueOnce(query(reopenable))
      .mockReturnValueOnce(query(occasionTaskRecord({ sourceDigest: 'x'.repeat(43) })));
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(query(updated))
      .mockReturnValueOnce(query(null));
    const create = vi.fn().mockResolvedValue([]);
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { findOne, findOneAndUpdate, create } as never,
    );
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(occasionTask(), session))).resolves.toMatchObject({
      changed: true,
    });
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(occasionTask(), session))).resolves.toMatchObject({
      changed: false,
      task: { status: 'delivered' },
    });
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(occasionTask(), session))).resolves.toMatchObject({
      changed: false,
      task: { status: 'pending' },
    });
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(occasionTask({ policyVersion: 'occasion-v2' }), session)))
      .resolves.toMatchObject({ changed: true, task: { version: 2 } });
    await expect(run(tenantContext, () =>
      repository.upsertPlanned(occasionTask(), session)))
      .rejects.toBeInstanceOf(CareWriteConflictError);
    expect(create).toHaveBeenCalledOnce();
  });

  it('取消待发送任务支持空结果、类型裁剪、成功更新和数量冲突', async () => {
    const tenantContext = context();
    const pending = [occasionTaskRecord(), occasionTaskRecord({
      id: 'occasion-task-002',
      occasionType: 'employment_anniversary',
    })];
    const find = vi.fn()
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query(pending))
      .mockReturnValueOnce(query(pending));
    const updateMany = vi.fn()
      .mockResolvedValueOnce({ modifiedCount: 2 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { find, updateMany } as never,
    );
    await expect(run(tenantContext, () => repository.cancelPendingByEmployee(
      'employee-001',
      'unsubscribed',
      NOW,
      session,
    ))).resolves.toEqual([]);
    const cancelled = await run(tenantContext, () => repository.cancelPendingByEmployee(
      'employee-001',
      'purpose_restricted',
      NOW,
      session,
      ['birthday'],
    ));
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]).toMatchObject({
      status: 'cancelled',
      denialCode: 'purpose_restricted',
      version: 2,
    });
    expect(find.mock.calls[1]?.[0]).toHaveProperty('occasionType.$nin');
    await expect(run(tenantContext, () => repository.cancelPendingByEmployee(
      'employee-001',
      'quiet_hours',
      NOW,
      session,
    ))).rejects.toBeInstanceOf(CareWriteConflictError);
  });

  it('按员工列举、按标识认领及幂等恢复当前 Worker 的任务', async () => {
    const tenantContext = context();
    const record = occasionTaskRecord({ status: 'dispatching', lockedBy: 'worker-001' });
    const find = vi.fn().mockReturnValue(query([record]));
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(query(record))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null));
    const findOne = vi.fn()
      .mockReturnValueOnce(query(record))
      .mockReturnValueOnce(query(null));
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { find, findOneAndUpdate, findOne } as never,
    );
    await expect(run(tenantContext, () =>
      repository.listByEmployeeId('employee-001', 10))).resolves.toHaveLength(1);
    await expect(run(tenantContext, () =>
      repository.claimById('occasion-task-001', 'worker-001', NOW)))
      .resolves.toMatchObject({ lockedBy: 'worker-001' });
    await expect(run(tenantContext, () =>
      repository.claimById('occasion-task-001', 'worker-001', NOW)))
      .resolves.toMatchObject({ lockedBy: 'worker-001' });
    await expect(run(tenantContext, () =>
      repository.claimById('missing', 'worker-001', NOW))).resolves.toBeNull();
  });

  it('死信重放、过期锁恢复、到期认领覆盖成功与空结果', async () => {
    const tenantContext = context();
    const record = occasionTaskRecord();
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(query(record))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(record))
      .mockReturnValueOnce(query(null));
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 3 });
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { findOneAndUpdate, updateMany } as never,
    );
    await expect(run(tenantContext, () =>
      repository.replayDeadById('occasion-task-001', NOW, session)))
      .resolves.toMatchObject({ status: 'pending' });
    await expect(run(tenantContext, () =>
      repository.replayDeadById('missing', NOW))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.recoverStaleLocks(NOW, 900_000))).resolves.toBe(3);
    await expect(run(tenantContext, () =>
      repository.claimDue('worker-001', NOW))).resolves.toMatchObject({
      id: 'occasion-task-001',
    });
    await expect(run(tenantContext, () =>
      repository.claimDue('worker-001', NOW))).resolves.toBeNull();
  });

  it('替换任务转换可选时间、校验租户并检测版本冲突', async () => {
    const tenantContext = context();
    const updateOne = vi.fn()
      .mockReturnValueOnce(query({ matchedCount: 1 }))
      .mockReturnValueOnce(query({ matchedCount: 1 }))
      .mockReturnValueOnce(query({ matchedCount: 0 }));
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { updateOne } as never,
    );
    await run(tenantContext, () => repository.replace(occasionTask(), 1, session));
    await run(tenantContext, () => repository.replace(occasionTask({
      lockedAt: NOW.toISOString(),
      deliveredAt: LATER.toISOString(),
      version: 2,
    }), 1));
    const terminalCall = JSON.stringify(updateOne.mock.calls[1]);
    expect(terminalCall).toContain(NOW.toISOString());
    expect(terminalCall).toContain(LATER.toISOString());
    await expect(run(tenantContext, () =>
      repository.replace(occasionTask(), 1))).rejects.toBeInstanceOf(CareWriteConflictError);
    await expect(run(tenantContext, () => repository.replace(
      occasionTask({ tenantId: 'tenant-other' }),
      1,
    ))).rejects.toThrow('拒绝跨租户实体');
  });

  it('积压聚合返回稳定低基数状态与最早时间', async () => {
    const tenantContext = context();
    const aggregate = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue([
        { _id: 'pending', count: 2, oldestAt: NOW },
        { _id: 'dead', count: 1, oldestAt: undefined },
      ]),
    });
    const repository = new CareOccasionTaskRepository(
      tenantContext,
      { aggregate } as never,
    );
    await expect(run(tenantContext, () => repository.backlog())).resolves.toEqual([
      { status: 'pending', count: 2, oldestAt: NOW.toISOString() },
      { status: 'dead', count: 1, oldestAt: null },
    ]);
  });
});

describe('CareOccasionTenantRepository', () => {
  it('注册当前租户并仅向空载荷 Worker 返回排序后的租户标识', async () => {
    const tenantContext = context();
    const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
    const find = vi.fn().mockReturnValue(query([
      { tenantId: 'tenant-001' },
      { tenantId: 'tenant-002' },
    ]));
    const repository = new CareOccasionTenantRepository(
      tenantContext,
      { updateOne, find } as never,
    );
    await run(tenantContext, () => repository.register(session));
    expect(updateOne).toHaveBeenCalledWith(
      { tenantId: tenant.tenantId },
      { $setOnInsert: { tenantId: tenant.tenantId } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    await expect(repository.listTenantIds(100)).resolves.toEqual([
      'tenant-001',
      'tenant-002',
    ]);
  });
});
