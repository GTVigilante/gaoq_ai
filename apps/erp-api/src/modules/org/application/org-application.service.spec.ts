import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { IdentityLifecycleService } from '../../identity/identity-lifecycle.service.js';
import type { Department, Employee } from '../domain/index.js';
import type {
  DepartmentRepository,
  EmployeeRepository,
  JobLevelRepository,
  PositionRepository,
  PersonRepository,
  EmploymentRepository,
  EmployeeNumberSequenceRepository,
} from '../persistence/org.repositories.js';
import type { OrgOutboxWriter } from '../persistence/outbox.writer.js';
import { OrgApplicationService } from './org-application.service.js';

const session = {} as ClientSession;
const NOW = '2026-07-21T00:00:00.000Z';

const trustedContext = {
  tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
  actor: {
    actorId: 'employee-001',
    actorType: 'user' as const,
    tenantId: 'tenant-001',
    roleCodes: ['employee'],
    scopes: ['erp:org:chart:read', 'erp:org:master:write'],
    departmentIds: ['dept-a'],
    traceId: 'trace-001',
  },
};

function department(id: string, parentId: string | null, version = 1): Department {
  return {
    id,
    tenantId: 'tenant-001',
    code: id.toUpperCase(),
    name: id,
    status: 'active',
    parentId,
    managerId: null,
    sortOrder: 0,
    version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function employee(id: string, departmentIds: readonly string[]): Employee {
  return {
    id,
    tenantId: 'tenant-001',
    employeeNo: id.toUpperCase(),
    displayName: id,
    status: 'active',
    departmentIds,
    primaryDepartmentId: departmentIds[0] ?? 'missing',
    positionIds: [],
    jobLevelId: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function assemble() {
  const context = new TenantContextService();
  const departmentRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findByIds: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const employeeRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const positionRepo = {
    findById: vi.fn().mockResolvedValue(null),
    findByIds: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const jobLevelRepo = {
    findById: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const personRepo = {
    findBySourceCandidateId: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const employmentRepo = {
    findByOnboardingInstanceId: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const employeeNumberRepo = { next: vi.fn().mockResolvedValue(1) };
  const outbox = { append: vi.fn().mockResolvedValue({}) };
  const terminateEmployee = vi.fn().mockResolvedValue({
    actorIds: [], accessProfileDisabled: false, externalIdentitiesDisabled: 0,
    sessionsRevoked: 0, refreshTokensRevoked: 0,
  });
  const execute = vi.fn(
    (_operation: string, _key: string, _request: unknown, handler: (value: ClientSession) => Promise<unknown>) =>
      handler(session),
  );
  const service = new OrgApplicationService(
    { execute } as unknown as IdempotencyService,
    context,
    departmentRepo as unknown as DepartmentRepository,
    employeeRepo as unknown as EmployeeRepository,
    positionRepo as unknown as PositionRepository,
    jobLevelRepo as unknown as JobLevelRepository,
    personRepo as unknown as PersonRepository,
    employmentRepo as unknown as EmploymentRepository,
    employeeNumberRepo as unknown as EmployeeNumberSequenceRepository,
    outbox as unknown as OrgOutboxWriter,
    { terminateEmployee } as unknown as IdentityLifecycleService,
  );
  return {
    context,
    service,
    execute,
    departmentRepo,
    employeeRepo,
    positionRepo,
    jobLevelRepo,
    personRepo,
    employmentRepo,
    employeeNumberRepo,
    outbox,
    terminateEmployee,
  };
}

describe('OrgApplicationService', () => {
  it('组织图只返回主体部门及其后代，过滤旁支员工', async () => {
    const store = assemble();
    store.departmentRepo.findAll.mockResolvedValue([
      department('dept-a', null),
      department('dept-a-child', 'dept-a'),
      department('dept-b', null),
    ]);
    store.employeeRepo.findAll.mockResolvedValue([
      employee('employee-a', ['dept-a-child']),
      employee('employee-b', ['dept-b']),
    ]);

    const chart = await store.context.run(trustedContext, () => store.service.getOrgChart());

    expect(chart.departments.map((item) => item.id)).toEqual(['dept-a', 'dept-a-child']);
    expect(chart.employees.map((item) => item.id)).toEqual(['employee-a']);
  });

  it('创建部门只使用可信租户，并在同一 session 写聚合与 Outbox', async () => {
    const store = assemble();

    const result = await store.context.run(trustedContext, () =>
      store.service.createDepartment('key-department-1', {
        code: 'FIN',
        name: '财务部',
      }),
    );

    expect(result.department.tenantId).toBe('tenant-001');
    expect(result.department.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.departmentRepo.insert).toHaveBeenCalledWith(result.department, session);
    expect(store.outbox.append.mock.calls[0]?.[1]).toBe(session);
    expect(store.execute).toHaveBeenCalledWith(
      'org.department.create',
      'key-department-1',
      expect.objectContaining({ code: 'FIN' }),
      expect.any(Function),
    );
  });

  it('更新部门时拒绝跨层级形成环', async () => {
    const store = assemble();
    store.departmentRepo.findById.mockImplementation((id: string) => {
      if (id === 'dept-a') return Promise.resolve(department('dept-a', null));
      if (id === 'dept-b') return Promise.resolve(department('dept-b', 'dept-a'));
      return Promise.resolve(null);
    });

    const failure = store.context.run(trustedContext, () =>
      store.service.updateDepartment('dept-a', 1, 'key-department-2', { parentId: 'dept-b' }),
    );

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'ORG_DEPARTMENT_CYCLE',
    });
    expect(store.departmentRepo.replace).not.toHaveBeenCalled();
  });

  it('创建员工时所有部门和岗位引用必须存在且启用', async () => {
    const store = assemble();
    store.departmentRepo.findByIds.mockResolvedValue([]);

    const failure = store.context.run(trustedContext, () =>
      store.service.createEmployee('key-employee-1', {
        employeeNo: 'E001',
        displayName: '测试员工',
        departmentIds: ['01K00000000000000000000000'],
        primaryDepartmentId: '01K00000000000000000000000',
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(BadRequestException);
    expect(store.employeeRepo.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('更新使用强版本前置条件，版本不一致返回冲突且不写库', async () => {
    const store = assemble();
    store.departmentRepo.findById.mockResolvedValue(department('dept-a', null, 2));

    const failure = store.context.run(trustedContext, () =>
      store.service.updateDepartment('dept-a', 1, 'key-department-3', { name: '新名称' }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    expect(store.departmentRepo.replace).not.toHaveBeenCalled();
  });

  it('业务唯一键冲突映射为稳定 ORG_UNIQUE_CONFLICT', async () => {
    const store = assemble();
    store.departmentRepo.insert.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));

    const failure = store.context.run(trustedContext, () =>
      store.service.createDepartment('key-department-4', { code: 'FIN', name: '财务部' }),
    );

    const error = await failure.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'ORG_UNIQUE_CONFLICT',
    });
  });

  it('离职迁移在同一事务中先封禁全部身份，再写员工和 Outbox', async () => {
    const store = assemble();
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    await store.context.run(trustedContext, () => store.service.transitionEmployeeStatus(
      'employee-001', 1, 'key-terminate-001', { status: 'terminated' },
    ));
    expect(store.terminateEmployee).toHaveBeenCalledWith(
      'tenant-001', 'employee-001', session,
    );
    expect(store.employeeRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'terminated' }), 1, session,
    );
    expect(store.terminateEmployee.mock.invocationCallOrder[0]).toBeLessThan(
      store.employeeRepo.replace.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(store.employeeRepo.replace.mock.invocationCallOrder[0]).toBeLessThan(
      store.outbox.append.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('非离职状态迁移不错误停用身份', async () => {
    const store = assemble();
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    await store.context.run(trustedContext, () => store.service.transitionEmployeeStatus(
      'employee-001', 1, 'key-suspend-001', { status: 'suspended' },
    ));
    expect(store.terminateEmployee).not.toHaveBeenCalled();
  });

  it('受信任入职工作流在同一事务建立三层主数据且工号由服务端生成', async () => {
    const store = assemble();
    const context = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        scopes: [...trustedContext.actor.scopes, 'erp:onboarding:employment:establish'],
      },
    };
    store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
    store.positionRepo.findByIds.mockResolvedValue([{
      id: 'position-a', tenantId: 'tenant-001', code: 'POS_A', name: '岗位A', status: 'active',
      version: 1, createdAt: NOW, updatedAt: NOW,
    }]);
    store.jobLevelRepo.findById.mockResolvedValue({
      id: 'level-a', tenantId: 'tenant-001', code: 'P5', name: 'P5',
      track: 'professional', rank: 5, version: 1, createdAt: NOW, updatedAt: NOW,
    });

    const result = await store.context.run(context, () =>
      store.service.establishEmploymentFromOnboarding('key-onboarding-employment-001', {
        onboardingInstanceId: 'onboarding-001', candidateId: 'candidate-001',
        onboardingCompletionEvidenceId: 'onboarding-evidence-001',
        offerId: 'offer-001', signedEvidenceId: 'signed-evidence-001',
        identityEvidenceId: 'identity-evidence-001', displayName: '新员工',
        primaryDepartmentId: 'dept-a', orgPositionId: 'position-a',
        jobLevelId: 'level-a', effectiveFrom: '2026-08-01T00:00:00.000Z',
      }),
    );

    expect(result.employeeNo).toMatch(/^E\d{10}$/);
    expect(store.personRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCandidateId: 'candidate-001' }), session,
    );
    expect(store.employeeRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ employeeNo: result.employeeNo, status: 'probation' }), session,
    );
    expect(store.employmentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingInstanceId: 'onboarding-001' }), session,
    );
    expect(store.outbox.append).toHaveBeenCalledTimes(3);
  });

  it('入职工作流不能用新证据静默覆盖既有 Person 身份绑定', async () => {
    const store = assemble();
    const context = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        scopes: [...trustedContext.actor.scopes, 'erp:onboarding:employment:establish'],
      },
    };
    store.personRepo.findBySourceCandidateId.mockResolvedValue({
      id: 'person-001', tenantId: 'tenant-001', sourceCandidateId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-old', status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    });

    await expect(store.context.run(context, () =>
      store.service.establishEmploymentFromOnboarding('key-onboarding-employment-002', {
        onboardingInstanceId: 'onboarding-001', candidateId: 'candidate-001',
        onboardingCompletionEvidenceId: 'onboarding-evidence-001',
        offerId: 'offer-001', signedEvidenceId: 'signed-evidence-001',
        identityEvidenceId: 'identity-evidence-new', displayName: '新员工',
        primaryDepartmentId: 'dept-a', orgPositionId: 'position-a',
        jobLevelId: null, effectiveFrom: '2026-08-01T00:00:00.000Z',
      }),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(store.employeeRepo.insert).not.toHaveBeenCalled();
  });
});
