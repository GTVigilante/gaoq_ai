import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { IdentityLifecycleService } from '../../identity/identity-lifecycle.service.js';
import type {
  Department,
  Employee,
  Employment,
  JobLevel,
  Person,
  Position,
} from '../domain/index.js';
import { OrgWriteConflictError } from '../persistence/org.repositories.js';
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

function employment(): Employment {
  return {
    id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
    employeeId: 'employee-001', onboardingInstanceId: 'onboarding-001',
    onboardingCompletionEvidenceId: 'onboarding-evidence-001', offerId: 'offer-001',
    signedEvidenceId: 'signed-001', terminationCareCaseId: null,
    terminationExecutionEvidenceId: null, terminationEvidenceId: null,
    status: 'active', effectiveFrom: '2026-07-01', effectiveTo: null,
    version: 1, createdAt: NOW, updatedAt: NOW,
  };
}

function position(id: string, status: Position['status'] = 'active', version = 1): Position {
  return {
    id,
    tenantId: 'tenant-001',
    code: id.toUpperCase(),
    name: id,
    status,
    version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function jobLevel(id: string, version = 1): JobLevel {
  return {
    id,
    tenantId: 'tenant-001',
    code: id.toUpperCase(),
    name: id,
    track: 'professional',
    rank: 5,
    version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function person(id = 'person-001'): Person {
  return {
    id,
    tenantId: 'tenant-001',
    sourceCandidateId: 'candidate-001',
    identityEvidenceId: 'identity-evidence-001',
    birthdayEvidenceId: null,
    birthdayAttestedAt: null,
    status: 'active',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function contextWith(...scopes: readonly string[]) {
  return {
    ...trustedContext,
    actor: {
      ...trustedContext.actor,
      actorType: 'service' as const,
      scopes: [...trustedContext.actor.scopes, ...scopes],
    },
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
    findById: vi.fn().mockResolvedValue(null),
    findOpenByEmployeeId: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
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

  it('通用员工状态接口拒绝绕过 Care 直接离职', async () => {
    const store = assemble();
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    await expect(store.context.run(trustedContext, () => store.service.transitionEmployeeStatus(
      'employee-001', 1, 'key-terminate-001', { status: 'terminated' },
    ))).rejects.toMatchObject({ response: { code: 'ORG_CARE_WORKFLOW_REQUIRED' } });
    expect(store.terminateEmployee).not.toHaveBeenCalled();
  });

  it('Care 窄接口在同一事务关闭劳动关系、封禁身份并终止员工', async () => {
    const store = assemble();
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    store.employmentRepo.findById.mockResolvedValue(employment());
    const careContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        scopes: [...trustedContext.actor.scopes, 'erp:care:employment:terminate'],
      },
    };
    const result = await store.context.run(careContext, () =>
      store.service.terminateEmploymentFromCare('key-care-terminate-001', {
        careCaseId: 'care-001', employeeId: 'employee-001', employmentId: 'employment-001',
        effectiveTo: '2026-07-31', executionEvidenceId: 'execution-001',
      }),
    );
    expect(result.employment).toMatchObject({ status: 'resigned', effectiveTo: '2026-07-31' });
    expect(store.terminateEmployee).toHaveBeenCalledWith(
      'tenant-001', 'employee-001', session,
    );
    expect(store.employmentRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resigned', terminationCareCaseId: 'care-001' }), 1, session,
    );
    expect(store.employeeRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'terminated' }), 1, session,
    );
    expect(store.terminateEmployee.mock.invocationCallOrder[0]).toBeLessThan(
      store.employmentRepo.replace.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(store.employmentRepo.replace.mock.invocationCallOrder[0]).toBeLessThan(
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

  it('转正或停职在同一事务同步 Employee 与当前 Employment', async () => {
    const store = assemble();
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    store.employmentRepo.findOpenByEmployeeId.mockResolvedValue(employment());
    await store.context.run(trustedContext, () => store.service.transitionEmployeeStatus(
      'employee-001', 1, 'key-employment-suspend-001', { status: 'suspended' },
    ));
    expect(store.employmentRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', version: 2 }), 1, session,
    );
    expect(store.employeeRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', version: 2 }), 1, session,
    );
  });

  it('迁移同步在一个事务内更新员工资料、状态与开放劳动关系', async () => {
    const store = assemble();
    const migrationContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        actorType: 'service' as const,
        scopes: [...trustedContext.actor.scopes, 'erp:migration:execute'],
      },
    };
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
    store.employmentRepo.findOpenByEmployeeId.mockResolvedValue(employment());

    const result = await store.context.run(migrationContext, () =>
      store.service.synchronizeEmployeeFromMigration(
        'employee-001', 1, 'key-migration-employee-001', {
          employeeNo: 'EMPLOYEE-001', displayName: '迁移员工', status: 'suspended',
          departmentIds: ['dept-a'], primaryDepartmentId: 'dept-a',
          positionIds: [], jobLevelId: null,
        },
      ));

    expect(result.employee).toMatchObject({
      displayName: '迁移员工', status: 'suspended', version: 3,
    });
    expect(store.employmentRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', version: 2 }), 1, session,
    );
    expect(store.employeeRepo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', version: 3 }), 1, session,
    );
    expect(store.outbox.append).toHaveBeenCalledTimes(3);
  });

  it('迁移同步不能把既有员工直接改为离职', async () => {
    const store = assemble();
    const migrationContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        actorType: 'service' as const,
        scopes: [...trustedContext.actor.scopes, 'erp:migration:execute'],
      },
    };
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));

    const failure = store.context.run(migrationContext, () =>
      store.service.synchronizeEmployeeFromMigration(
        'employee-001', 1, 'key-migration-employee-terminate-001', {
          employeeNo: 'EMPLOYEE-001', displayName: '迁移员工', status: 'terminated',
          departmentIds: ['dept-a'], primaryDepartmentId: 'dept-a',
          positionIds: [], jobLevelId: null,
        },
      ));

    await expect(failure).rejects.toMatchObject({
      response: { code: 'ORG_CARE_WORKFLOW_REQUIRED' },
    });
    expect(store.employeeRepo.replace).not.toHaveBeenCalled();
    expect(store.employmentRepo.replace).not.toHaveBeenCalled();
  });

  it('迁移恢复劳动关系只绑定既有员工并写入证据化 Person 与 Outbox', async () => {
    const store = assemble();
    const migrationContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        actorType: 'service' as const,
        scopes: [...trustedContext.actor.scopes, 'erp:migration:execute'],
      },
    };
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));

    const result = await store.context.run(migrationContext, () =>
      store.service.importEmploymentFromMigration('key-migration-employment-001', {
        employeeId: 'employee-001', sourcePersonId: 'legacy-person-001',
        identityEvidenceId: 'identity-evidence-001',
        onboardingInstanceId: 'legacy-onboarding-001',
        onboardingCompletionEvidenceId: 'onboarding-evidence-001',
        offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
        status: 'active', effectiveFrom: '2018-01-01', effectiveTo: null,
        terminationCareCaseId: null, terminationExecutionEvidenceId: null,
        terminationEvidenceId: null,
      }));

    expect(result.employment).toMatchObject({
      employeeId: 'employee-001', status: 'active', effectiveFrom: '2018-01-01',
    });
    expect(store.personRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCandidateId: 'legacy-person-001' }), session,
    );
    expect(store.employmentRepo.insert).toHaveBeenCalledWith(result.employment, session);
    expect(store.employeeRepo.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('迁移恢复拒绝劳动关系与员工状态不一致', async () => {
    const store = assemble();
    const migrationContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        actorType: 'service' as const,
        scopes: [...trustedContext.actor.scopes, 'erp:migration:execute'],
      },
    };
    store.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));

    await expect(store.context.run(migrationContext, () =>
      store.service.importEmploymentFromMigration('key-migration-employment-002', {
        employeeId: 'employee-001', sourcePersonId: 'legacy-person-001',
        identityEvidenceId: 'identity-evidence-001',
        onboardingInstanceId: 'legacy-onboarding-001',
        onboardingCompletionEvidenceId: 'onboarding-evidence-001',
        offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
        status: 'resigned', effectiveFrom: '2018-01-01', effectiveTo: '2024-06-30',
        terminationCareCaseId: 'legacy-care-001',
        terminationExecutionEvidenceId: 'legacy-execution-001',
        terminationEvidenceId: 'legacy-termination-001',
      }))).rejects.toMatchObject({
      response: { code: 'ORG_MIGRATION_EMPLOYMENT_STATUS_MISMATCH' },
    });
    expect(store.employmentRepo.insert).not.toHaveBeenCalled();
  });

  it('迁移恢复劳动关系必须同时持有组织域写权限', async () => {
    const store = assemble();
    const migrationContext = {
      ...trustedContext,
      actor: {
        ...trustedContext.actor,
        actorType: 'service' as const,
        scopes: ['erp:migration:execute'],
      },
    };
    await expect(store.context.run(migrationContext, () =>
      store.service.importEmploymentFromMigration('key-migration-employment-003', {
        employeeId: 'employee-001', sourcePersonId: 'legacy-person-001',
        identityEvidenceId: 'identity-evidence-001',
        onboardingInstanceId: 'legacy-onboarding-001',
        onboardingCompletionEvidenceId: 'onboarding-evidence-001',
        offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
        status: 'active', effectiveFrom: '2018-01-01', effectiveTo: null,
        terminationCareCaseId: null, terminationExecutionEvidenceId: null,
        terminationEvidenceId: null,
      }))).rejects.toMatchObject({
      response: { code: 'ORG_TRUSTED_WORKFLOW_REQUIRED' },
    });
    expect(store.employeeRepo.findById).not.toHaveBeenCalled();
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
        jobLevelId: 'level-a', effectiveFrom: '2026-08-01',
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
        jobLevelId: null, effectiveFrom: '2026-08-01',
      }),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(store.employeeRepo.insert).not.toHaveBeenCalled();
  });

  it('全局组织图权限返回全部主数据，空部门范围不会泄露员工', async () => {
    const all = assemble();
    all.departmentRepo.findAll.mockResolvedValue([
      department('dept-a', null),
      department('dept-b', null),
    ]);
    all.employeeRepo.findAll.mockResolvedValue([
      employee('employee-a', ['dept-a']),
      employee('employee-b', ['dept-b']),
    ]);
    const allContext = contextWith('erp:org:chart:read_all');
    const chart = await all.context.run(allContext, () => all.service.getOrgChart());
    expect(chart.departments.map((item) => item.id)).toEqual(['dept-a', 'dept-b']);
    expect(chart.employees.map((item) => item.id)).toEqual(['employee-a', 'employee-b']);

    const empty = assemble();
    empty.departmentRepo.findAll.mockResolvedValue([department('dept-a', null)]);
    empty.employeeRepo.findAll.mockResolvedValue([employee('employee-a', ['dept-a'])]);
    const emptyContext = {
      ...trustedContext,
      actor: { ...trustedContext.actor, departmentIds: [] },
    };
    await expect(empty.context.run(emptyContext, () => empty.service.getOrgChart())).resolves.toEqual({
      departments: [],
      employees: [],
    });
  });

  it('Care 劳动关系只读接口强制专用权限并拒绝断裂引用', async () => {
    const denied = assemble();
    await expect(denied.context.run(trustedContext, () =>
      denied.service.getEmploymentForCare('employment-001'),
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.employmentRepo.findById).not.toHaveBeenCalled();

    const missingEmployment = assemble();
    await expect(missingEmployment.context.run(
      contextWith('erp:care:employment:read'),
      () => missingEmployment.service.getEmploymentForCare('employment-001'),
    )).rejects.toBeInstanceOf(NotFoundException);

    const missingEmployee = assemble();
    missingEmployee.employmentRepo.findById.mockResolvedValue(employment());
    await expect(missingEmployee.context.run(
      contextWith('erp:care:employment:read'),
      () => missingEmployee.service.getEmploymentForCare('employment-001'),
    )).rejects.toMatchObject({ response: { code: 'ORG_NOT_FOUND' } });

    const found = assemble();
    found.employmentRepo.findById.mockResolvedValue(employment());
    found.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    await expect(found.context.run(
      contextWith('erp:care:employment:read'),
      () => found.service.getEmploymentForCare('employment-001'),
    )).resolves.toMatchObject({
      employee: { id: 'employee-001' },
      employment: { id: 'employment-001' },
    });
  });

  it('岗位与职级创建更新复用可信租户、强版本和 Outbox 事务', async () => {
    const store = assemble();
    const createdPosition = await store.context.run(trustedContext, () =>
      store.service.createPosition('key-position-create', { code: 'DEV', name: '开发' }),
    );
    expect(createdPosition.position).toMatchObject({ tenantId: 'tenant-001', version: 1 });
    expect(store.positionRepo.insert).toHaveBeenCalledWith(createdPosition.position, session);

    store.positionRepo.findById.mockResolvedValue(position('position-a'));
    const updatedPosition = await store.context.run(trustedContext, () =>
      store.service.updatePosition('position-a', 1, 'key-position-update', { status: 'inactive' }),
    );
    expect(updatedPosition.position).toMatchObject({ status: 'inactive', version: 2 });
    expect(store.positionRepo.replace).toHaveBeenCalledWith(
      updatedPosition.position,
      1,
      session,
    );

    const createdLevel = await store.context.run(trustedContext, () =>
      store.service.createJobLevel('key-level-create', {
        code: 'P5',
        name: '专业五级',
        track: 'professional',
        rank: 5,
      }),
    );
    expect(createdLevel.jobLevel).toMatchObject({ tenantId: 'tenant-001', version: 1 });
    store.jobLevelRepo.findById.mockResolvedValue(jobLevel('level-a'));
    const updatedLevel = await store.context.run(trustedContext, () =>
      store.service.updateJobLevel('level-a', 1, 'key-level-update', {
        track: 'management',
        rank: 6,
      }),
    );
    expect(updatedLevel.jobLevel).toMatchObject({
      track: 'management',
      rank: 6,
      version: 2,
    });
    expect(store.outbox.append).toHaveBeenCalledTimes(4);
  });

  it('岗位与职级更新拒绝空补丁、缺失实体和版本漂移', async () => {
    const empty = assemble();
    await expect(empty.context.run(trustedContext, () =>
      empty.service.updatePosition('position-a', 1, 'key-position-empty', {}),
    )).rejects.toMatchObject({ response: { code: 'ORG_EMPTY_PATCH' } });
    await expect(empty.context.run(trustedContext, () =>
      empty.service.updateJobLevel('level-a', 1, 'key-level-empty', {}),
    )).rejects.toMatchObject({ response: { code: 'ORG_EMPTY_PATCH' } });

    const missing = assemble();
    await expect(missing.context.run(trustedContext, () =>
      missing.service.updatePosition('position-a', 1, 'key-position-missing', { name: '岗位' }),
    )).rejects.toMatchObject({ response: { code: 'ORG_NOT_FOUND' } });
    await expect(missing.context.run(trustedContext, () =>
      missing.service.updateJobLevel('level-a', 1, 'key-level-missing', { name: '职级' }),
    )).rejects.toMatchObject({ response: { code: 'ORG_NOT_FOUND' } });

    const conflict = assemble();
    conflict.positionRepo.findById.mockResolvedValue(position('position-a', 'active', 2));
    conflict.jobLevelRepo.findById.mockResolvedValue(jobLevel('level-a', 2));
    await expect(conflict.context.run(trustedContext, () =>
      conflict.service.updatePosition('position-a', 1, 'key-position-conflict', { name: '岗位' }),
    )).rejects.toMatchObject({ response: { code: 'ORG_VERSION_CONFLICT' } });
    await expect(conflict.context.run(trustedContext, () =>
      conflict.service.updateJobLevel('level-a', 1, 'key-level-conflict', { name: '职级' }),
    )).rejects.toMatchObject({ response: { code: 'ORG_VERSION_CONFLICT' } });
  });

  it('员工创建更新校验启用部门、岗位与职级后原子发布事件', async () => {
    const store = assemble();
    store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
    store.positionRepo.findByIds.mockResolvedValue([position('position-a')]);
    store.jobLevelRepo.findById.mockResolvedValue(jobLevel('level-a'));
    const created = await store.context.run(trustedContext, () =>
      store.service.createEmployee('key-employee-create-valid', {
        employeeNo: 'E001',
        displayName: '员工',
        departmentIds: ['dept-a'],
        primaryDepartmentId: 'dept-a',
        positionIds: ['position-a'],
        jobLevelId: 'level-a',
      }),
    );
    expect(store.employeeRepo.insert).toHaveBeenCalledWith(created.employee, session);

    store.employeeRepo.findById.mockResolvedValue(created.employee);
    const updated = await store.context.run(trustedContext, () =>
      store.service.updateEmployee(
        created.employee.id,
        1,
        'key-employee-update-valid',
        { displayName: '员工新名' },
      ),
    );
    expect(updated.employee).toMatchObject({ displayName: '员工新名', version: 2 });
    expect(store.employeeRepo.replace).toHaveBeenCalledWith(updated.employee, 1, session);
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('员工引用校验逐类拒绝停用部门、缺失岗位和缺失职级', async () => {
    const cases = [
      {
        prepare: (store: ReturnType<typeof assemble>) => {
          store.departmentRepo.findByIds.mockResolvedValue([
            { ...department('dept-a', null), status: 'inactive' },
          ]);
        },
        expectedCode: 'ORG_INVALID_DEPARTMENT_REFERENCE',
      },
      {
        prepare: (store: ReturnType<typeof assemble>) => {
          store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
          store.positionRepo.findByIds.mockResolvedValue([]);
        },
        expectedCode: 'ORG_INVALID_POSITION_REFERENCE',
      },
      {
        prepare: (store: ReturnType<typeof assemble>) => {
          store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
          store.positionRepo.findByIds.mockResolvedValue([position('position-a')]);
        },
        expectedCode: 'ORG_INVALID_JOB_LEVEL_REFERENCE',
      },
    ];
    for (const { prepare, expectedCode } of cases) {
      const store = assemble();
      prepare(store);
      await expect(store.context.run(trustedContext, () =>
        store.service.createEmployee(`key-${expectedCode}`, {
          employeeNo: 'E001',
          displayName: '员工',
          departmentIds: ['dept-a'],
          primaryDepartmentId: 'dept-a',
          positionIds: ['position-a'],
          jobLevelId: 'level-a',
        }),
      )).rejects.toMatchObject({ response: { code: expectedCode } });
      expect(store.employeeRepo.insert).not.toHaveBeenCalled();
    }
  });

  it('入职组织分配校验强制专用权限并逐类失败关闭', async () => {
    const denied = assemble();
    await expect(denied.context.run(trustedContext, () =>
      denied.service.validateOnboardingAssignment({
        departmentId: 'dept-a',
        orgPositionId: 'position-a',
        jobLevelId: null,
      }),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const scenarios = [
      {
        department: null,
        position: position('position-a'),
        level: jobLevel('level-a'),
        code: 'ORG_INVALID_DEPARTMENT_REFERENCE',
      },
      {
        department: { ...department('dept-a', null), status: 'inactive' as const },
        position: position('position-a'),
        level: jobLevel('level-a'),
        code: 'ORG_INVALID_DEPARTMENT_REFERENCE',
      },
      {
        department: department('dept-a', null),
        position: null,
        level: jobLevel('level-a'),
        code: 'ORG_INVALID_POSITION_REFERENCE',
      },
      {
        department: department('dept-a', null),
        position: position('position-a', 'inactive'),
        level: jobLevel('level-a'),
        code: 'ORG_INVALID_POSITION_REFERENCE',
      },
      {
        department: department('dept-a', null),
        position: position('position-a'),
        level: null,
        code: 'ORG_INVALID_JOB_LEVEL_REFERENCE',
      },
    ];
    for (const scenario of scenarios) {
      const store = assemble();
      store.departmentRepo.findById.mockResolvedValue(scenario.department);
      store.positionRepo.findById.mockResolvedValue(scenario.position);
      store.jobLevelRepo.findById.mockResolvedValue(scenario.level);
      await expect(store.context.run(
        contextWith('erp:onboarding:org:validate'),
        () => store.service.validateOnboardingAssignment({
          departmentId: 'dept-a',
          orgPositionId: 'position-a',
          jobLevelId: 'level-a',
        }),
      )).rejects.toMatchObject({ response: { code: scenario.code } });
    }

    const valid = assemble();
    valid.departmentRepo.findById.mockResolvedValue(department('dept-a', null));
    valid.positionRepo.findById.mockResolvedValue(position('position-a'));
    await expect(valid.context.run(
      contextWith('erp:onboarding:org:validate'),
      () => valid.service.validateOnboardingAssignment({
        departmentId: 'dept-a',
        orgPositionId: 'position-a',
        jobLevelId: null,
      }),
    )).resolves.toEqual({ verified: true });
    expect(valid.jobLevelRepo.findById).not.toHaveBeenCalled();
  });

  it('入职实例已有一致事实时幂等收敛，任何证据漂移均冲突', async () => {
    const baseEmployment = employment();
    const basePerson = person();
    const matching = assemble();
    matching.employmentRepo.findByOnboardingInstanceId.mockResolvedValue(baseEmployment);
    matching.personRepo.findBySourceCandidateId.mockResolvedValue(basePerson);
    matching.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    const input = {
      onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001',
      candidateId: 'candidate-001',
      offerId: 'offer-001',
      signedEvidenceId: 'signed-001',
      identityEvidenceId: 'identity-evidence-001',
      displayName: '员工',
      primaryDepartmentId: 'dept-a',
      orgPositionId: 'position-a',
      jobLevelId: null,
      effectiveFrom: '2026-07-01',
    };
    await expect(matching.context.run(
      contextWith('erp:onboarding:employment:establish'),
      () => matching.service.establishEmploymentFromOnboarding('key-onboarding-existing', input),
    )).resolves.toMatchObject({
      employment: { id: 'employment-001' },
      employeeId: 'employee-001',
      personId: 'person-001',
    });
    expect(matching.employeeNumberRepo.next).not.toHaveBeenCalled();

    for (const existing of [
      { ...baseEmployment, offerId: 'offer-other' },
      { ...baseEmployment, signedEvidenceId: 'signed-other' },
      { ...baseEmployment, onboardingCompletionEvidenceId: 'evidence-other' },
      { ...baseEmployment, effectiveFrom: '2026-07-02' },
    ]) {
      const conflict = assemble();
      conflict.employmentRepo.findByOnboardingInstanceId.mockResolvedValue(existing);
      await expect(conflict.context.run(
        contextWith('erp:onboarding:employment:establish'),
        () => conflict.service.establishEmploymentFromOnboarding('key-onboarding-conflict', input),
      )).rejects.toMatchObject({ response: { code: 'ORG_ONBOARDING_EMPLOYMENT_MISMATCH' } });
    }

    for (const existingPerson of [
      null,
      { ...basePerson, id: 'person-other' },
      { ...basePerson, identityEvidenceId: 'identity-other' },
    ]) {
      const conflict = assemble();
      conflict.employmentRepo.findByOnboardingInstanceId.mockResolvedValue(baseEmployment);
      conflict.personRepo.findBySourceCandidateId.mockResolvedValue(existingPerson);
      await expect(conflict.context.run(
        contextWith('erp:onboarding:employment:establish'),
        () => conflict.service.establishEmploymentFromOnboarding('key-onboarding-person', input),
      )).rejects.toMatchObject({ response: { code: 'ORG_ONBOARDING_PERSON_MISMATCH' } });
    }
  });

  it('入职工号序列耗尽时失败关闭且不写三层主数据', async () => {
    const store = assemble();
    store.personRepo.findBySourceCandidateId.mockResolvedValue(person());
    store.employeeNumberRepo.next.mockResolvedValue(1_000_000);
    await expect(store.context.run(
      contextWith('erp:onboarding:employment:establish'),
      () => store.service.establishEmploymentFromOnboarding('key-onboarding-exhausted', {
        onboardingInstanceId: 'onboarding-002',
        onboardingCompletionEvidenceId: 'onboarding-evidence-002',
        candidateId: 'candidate-001',
        offerId: 'offer-002',
        signedEvidenceId: 'signed-002',
        identityEvidenceId: 'identity-evidence-001',
        displayName: '员工',
        primaryDepartmentId: 'dept-a',
        orgPositionId: 'position-a',
        jobLevelId: null,
        effectiveFrom: '2026-08-01',
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_EMPLOYEE_NUMBER_EXHAUSTED' } });
    expect(store.personRepo.insert).not.toHaveBeenCalled();
    expect(store.employeeRepo.insert).not.toHaveBeenCalled();
    expect(store.employmentRepo.insert).not.toHaveBeenCalled();
  });

  it('入职工作流复用同一身份事实时不重复创建 Person', async () => {
    const store = assemble();
    store.personRepo.findBySourceCandidateId.mockResolvedValue(person());
    store.departmentRepo.findByIds.mockResolvedValue([department('dept-a', null)]);
    store.positionRepo.findByIds.mockResolvedValue([position('position-a')]);
    const result = await store.context.run(
      contextWith('erp:onboarding:employment:establish'),
      () => store.service.establishEmploymentFromOnboarding('key-onboarding-reuse-person', {
        onboardingInstanceId: 'onboarding-002',
        onboardingCompletionEvidenceId: 'onboarding-evidence-002',
        candidateId: 'candidate-001',
        offerId: 'offer-002',
        signedEvidenceId: 'signed-002',
        identityEvidenceId: 'identity-evidence-001',
        displayName: '员工',
        primaryDepartmentId: 'dept-a',
        orgPositionId: 'position-a',
        jobLevelId: null,
        effectiveFrom: '2026-08-01',
      }),
    );
    expect(result.personId).toBe('person-001');
    expect(store.personRepo.insert).not.toHaveBeenCalled();
    expect(store.employeeRepo.insert).toHaveBeenCalledOnce();
    expect(store.employmentRepo.insert).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('迁移既有劳动关系只在所有不可变事实一致时幂等收敛', async () => {
    const input = {
      employeeId: 'employee-001',
      sourcePersonId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-001',
      onboardingInstanceId: 'onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001',
      offerId: 'offer-001',
      signedEvidenceId: 'signed-001',
      status: 'active' as const,
      effectiveFrom: '2026-07-01',
      effectiveTo: null,
      terminationCareCaseId: null,
      terminationExecutionEvidenceId: null,
      terminationEvidenceId: null,
    };
    const baseEmployment = employment();
    const basePerson = person();
    const exact = assemble();
    exact.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    exact.employmentRepo.findByOnboardingInstanceId.mockResolvedValue(baseEmployment);
    exact.personRepo.findBySourceCandidateId.mockResolvedValue(basePerson);
    await expect(exact.context.run(
      contextWith('erp:migration:execute'),
      () => exact.service.importEmploymentFromMigration('key-migration-existing', input),
    )).resolves.toEqual({ employment: baseEmployment, personId: 'person-001' });
    expect(exact.employmentRepo.insert).not.toHaveBeenCalled();

    const factMutations: readonly Employment[] = [
      { ...baseEmployment, personId: 'person-other' },
      { ...baseEmployment, employeeId: 'employee-other' },
      { ...baseEmployment, onboardingInstanceId: 'onboarding-other' },
      { ...baseEmployment, onboardingCompletionEvidenceId: 'evidence-other' },
      { ...baseEmployment, offerId: 'offer-other' },
      { ...baseEmployment, signedEvidenceId: 'signed-other' },
      { ...baseEmployment, status: 'suspended' },
      { ...baseEmployment, effectiveFrom: '2026-07-02' },
      { ...baseEmployment, effectiveTo: '2026-07-31' },
      { ...baseEmployment, terminationCareCaseId: 'care-other' },
      { ...baseEmployment, terminationExecutionEvidenceId: 'execution-other' },
      { ...baseEmployment, terminationEvidenceId: 'termination-other' },
    ];
    for (const existing of factMutations) {
      const conflict = assemble();
      conflict.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
      conflict.employmentRepo.findByOnboardingInstanceId.mockResolvedValue(existing);
      conflict.personRepo.findBySourceCandidateId.mockResolvedValue(basePerson);
      await expect(conflict.context.run(
        contextWith('erp:migration:execute'),
        () => conflict.service.importEmploymentFromMigration('key-migration-conflict', input),
      )).rejects.toMatchObject({ response: { code: 'ORG_MIGRATION_EMPLOYMENT_IMMUTABLE' } });
    }
  });

  it('迁移新劳动关系复用同一 Person，拒绝身份核验证据漂移', async () => {
    const input = {
      employeeId: 'employee-001',
      sourcePersonId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-001',
      onboardingInstanceId: 'onboarding-002',
      onboardingCompletionEvidenceId: 'onboarding-evidence-002',
      offerId: 'offer-002',
      signedEvidenceId: 'signed-002',
      status: 'active' as const,
      effectiveFrom: '2026-07-01',
      effectiveTo: null,
      terminationCareCaseId: null,
      terminationExecutionEvidenceId: null,
      terminationEvidenceId: null,
    };
    const reused = assemble();
    reused.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    reused.personRepo.findBySourceCandidateId.mockResolvedValue(person());
    await expect(reused.context.run(
      contextWith('erp:migration:execute'),
      () => reused.service.importEmploymentFromMigration('key-migration-reuse-person', input),
    )).resolves.toMatchObject({ personId: 'person-001' });
    expect(reused.personRepo.insert).not.toHaveBeenCalled();
    expect(reused.employmentRepo.insert).toHaveBeenCalledOnce();
    expect(reused.outbox.append).toHaveBeenCalledOnce();

    const conflict = assemble();
    conflict.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    conflict.personRepo.findBySourceCandidateId.mockResolvedValue({
      ...person(),
      identityEvidenceId: 'identity-evidence-other',
    });
    await expect(conflict.context.run(
      contextWith('erp:migration:execute'),
      () => conflict.service.importEmploymentFromMigration('key-migration-person-conflict', input),
    )).rejects.toMatchObject({ response: { code: 'ORG_PERSON_IDENTITY_EVIDENCE_MISMATCH' } });
    expect(conflict.employmentRepo.insert).not.toHaveBeenCalled();
  });

  it('Care 已关闭事实只允许完全一致幂等返回，其他组合失败关闭', async () => {
    const terminatedEmployee = {
      ...employee('employee-001', ['dept-a']),
      status: 'terminated' as const,
    };
    const resignedEmployment = {
      ...employment(),
      status: 'resigned' as const,
      effectiveTo: '2026-07-31',
      terminationCareCaseId: 'care-001',
      terminationExecutionEvidenceId: 'execution-001',
      terminationEvidenceId: 'termination-001',
    };
    const input = {
      careCaseId: 'care-001',
      employeeId: 'employee-001',
      employmentId: 'employment-001',
      effectiveTo: '2026-07-31',
      executionEvidenceId: 'execution-001',
    };
    const exact = assemble();
    exact.employeeRepo.findById.mockResolvedValue(terminatedEmployee);
    exact.employmentRepo.findById.mockResolvedValue(resignedEmployment);
    await expect(exact.context.run(
      contextWith('erp:care:employment:terminate'),
      () => exact.service.terminateEmploymentFromCare('key-care-existing', input),
    )).resolves.toMatchObject({ terminationEvidenceId: 'termination-001' });
    expect(exact.terminateEmployee).not.toHaveBeenCalled();

    const mismatches = [
      { employee: employee('employee-001', ['dept-a']), employment: resignedEmployment },
      {
        employee: terminatedEmployee,
        employment: { ...resignedEmployment, terminationCareCaseId: 'care-other' },
      },
      {
        employee: terminatedEmployee,
        employment: { ...resignedEmployment, terminationExecutionEvidenceId: 'execution-other' },
      },
      {
        employee: terminatedEmployee,
        employment: { ...resignedEmployment, effectiveTo: '2026-07-30' },
      },
      {
        employee: terminatedEmployee,
        employment: { ...resignedEmployment, terminationEvidenceId: null },
      },
    ];
    for (const mismatch of mismatches) {
      const conflict = assemble();
      conflict.employeeRepo.findById.mockResolvedValue(mismatch.employee);
      conflict.employmentRepo.findById.mockResolvedValue(mismatch.employment);
      await expect(conflict.context.run(
        contextWith('erp:care:employment:terminate'),
        () => conflict.service.terminateEmploymentFromCare('key-care-mismatch', input),
      )).rejects.toMatchObject({ response: { code: 'ORG_CARE_TERMINATION_MISMATCH' } });
    }
  });

  it('Care 关闭拒绝缺失劳动关系、错绑员工和遗留不一致终态', async () => {
    const missing = assemble();
    missing.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    await expect(missing.context.run(
      contextWith('erp:care:employment:terminate'),
      () => missing.service.terminateEmploymentFromCare('key-care-missing', {
        careCaseId: 'care-001',
        employeeId: 'employee-001',
        employmentId: 'employment-001',
        effectiveTo: '2026-07-31',
        executionEvidenceId: 'execution-001',
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_EMPLOYMENT_NOT_FOUND' } });

    const wrongEmployee = assemble();
    wrongEmployee.employeeRepo.findById.mockResolvedValue(employee('employee-001', ['dept-a']));
    wrongEmployee.employmentRepo.findById.mockResolvedValue({
      ...employment(),
      employeeId: 'employee-other',
    });
    await expect(wrongEmployee.context.run(
      contextWith('erp:care:employment:terminate'),
      () => wrongEmployee.service.terminateEmploymentFromCare('key-care-wrong-employee', {
        careCaseId: 'care-001',
        employeeId: 'employee-001',
        employmentId: 'employment-001',
        effectiveTo: '2026-07-31',
        executionEvidenceId: 'execution-001',
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_CARE_EMPLOYMENT_MISMATCH' } });

    const legacy = assemble();
    legacy.employeeRepo.findById.mockResolvedValue({
      ...employee('employee-001', ['dept-a']),
      status: 'terminated',
    });
    legacy.employmentRepo.findById.mockResolvedValue(employment());
    await expect(legacy.context.run(
      contextWith('erp:care:employment:terminate'),
      () => legacy.service.terminateEmploymentFromCare('key-care-legacy', {
        careCaseId: 'care-001',
        employeeId: 'employee-001',
        employmentId: 'employment-001',
        effectiveTo: '2026-07-31',
        executionEvidenceId: 'execution-001',
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_LEGACY_TERMINATION_INCONSISTENT' } });
  });

  it('部门负责人必须存在且未离职，合法负责人可在同一事务绑定', async () => {
    for (const manager of [
      null,
      { ...employee('manager-001', ['dept-a']), status: 'terminated' as const },
    ]) {
      const invalid = assemble();
      invalid.employeeRepo.findById.mockResolvedValue(manager);
      await expect(invalid.context.run(trustedContext, () =>
        invalid.service.createDepartment('key-department-manager-invalid', {
          code: 'FIN',
          name: '财务部',
          managerId: 'manager-001',
        }),
      )).rejects.toMatchObject({ response: { code: 'ORG_INVALID_MANAGER' } });
      expect(invalid.departmentRepo.insert).not.toHaveBeenCalled();
    }

    const valid = assemble();
    valid.employeeRepo.findById.mockResolvedValue(employee('manager-001', ['dept-a']));
    await expect(valid.context.run(trustedContext, () =>
      valid.service.createDepartment('key-department-manager-valid', {
        code: 'FIN',
        name: '财务部',
        managerId: 'manager-001',
      }),
    )).resolves.toMatchObject({
      department: { managerId: 'manager-001' },
    });
  });

  it('领域校验错误映射为稳定组织错误码且不写仓储', async () => {
    const store = assemble();
    await expect(store.context.run(trustedContext, () =>
      store.service.createJobLevel('key-level-invalid-rank', {
        code: 'P31',
        name: '非法职级',
        track: 'professional',
        rank: 31,
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_INVALID_RANK' } });
    expect(store.jobLevelRepo.insert).not.toHaveBeenCalled();
  });

  it('仓储乐观锁冲突映射稳定版本错误，未知异常保持原样', async () => {
    const writeConflict = assemble();
    writeConflict.departmentRepo.insert.mockRejectedValue(
      new OrgWriteConflictError(),
    );
    await expect(writeConflict.context.run(trustedContext, () =>
      writeConflict.service.createDepartment('key-write-conflict', {
        code: 'FIN',
        name: '财务部',
      }),
    )).rejects.toMatchObject({ response: { code: 'ORG_VERSION_CONFLICT' } });

    for (const error of [new Error('MONGO_UNAVAILABLE'), null, { code: 42 }]) {
      const failed = assemble();
      failed.departmentRepo.insert.mockRejectedValue(error);
      await expect(failed.context.run(trustedContext, () =>
        failed.service.createDepartment('key-raw-error', {
          code: 'FIN',
          name: '财务部',
        }),
      )).rejects.toBe(error);
    }
  });
});
