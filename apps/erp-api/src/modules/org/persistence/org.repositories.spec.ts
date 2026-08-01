import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  DepartmentRepository,
  EmployeeNumberSequenceRepository,
  EmployeeRepository,
  EmploymentRepository,
  JobLevelRepository,
  OrgWriteConflictError,
  PersonRepository,
  PositionRepository,
} from './org.repositories.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'user',
  actorId: 'org-operator',
  tenantId: tenant.tenantId,
  roleCodes: ['org_admin'],
  scopes: ['erp:org:write'],
  departmentIds: [],
  traceId: 'trace-org-repository',
};
const session = {} as ClientSession;
const NOW = new Date('2026-07-27T08:00:00.000Z');
const LATER = new Date('2026-07-28T08:00:00.000Z');

function query<T>(value: T) {
  const chain = {
    session: vi.fn(),
    sort: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn(() => Promise.resolve(value)),
  };
  chain.session.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function context(): TenantContextService {
  return new TenantContextService();
}

function run<T>(tenantContext: TenantContextService, operation: () => T): T {
  return tenantContext.run({ tenant, actor }, operation);
}

function department(overrides: Record<string, unknown> = {}) {
  return {
    id: 'department-001',
    tenantId: tenant.tenantId,
    code: 'TECH',
    name: '技术部',
    status: 'active',
    parentId: null,
    managerId: null,
    sortOrder: 1,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function departmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...department(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function employee(overrides: Record<string, unknown> = {}) {
  return {
    id: 'employee-001',
    tenantId: tenant.tenantId,
    employeeNo: 'GQ20260001',
    displayName: '测试员工',
    status: 'active',
    departmentIds: ['department-001'],
    primaryDepartmentId: 'department-001',
    positionIds: ['position-001'],
    jobLevelId: 'job-level-001',
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function employeeRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...employee(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function person(overrides: Record<string, unknown> = {}) {
  return {
    id: 'person-001',
    tenantId: tenant.tenantId,
    sourceCandidateId: 'candidate-001',
    identityEvidenceId: 'identity-evidence-001',
    birthdayEvidenceId: null,
    birthdayAttestedAt: null,
    status: 'active',
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function personRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...person(),
    birthdayBlindIndexes: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function employment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'employment-001',
    tenantId: tenant.tenantId,
    personId: 'person-001',
    employeeId: 'employee-001',
    onboardingInstanceId: 'onboarding-001',
    onboardingCompletionEvidenceId: 'onboarding-evidence-001',
    offerId: 'offer-001',
    signedEvidenceId: 'signed-evidence-001',
    terminationCareCaseId: null,
    terminationExecutionEvidenceId: null,
    terminationEvidenceId: null,
    status: 'active',
    effectiveFrom: '2026-07-27',
    effectiveTo: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function employmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...employment(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 'position-001',
    tenantId: tenant.tenantId,
    code: 'ENGINEER',
    name: '工程师',
    status: 'active',
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function positionRecord(overrides: Record<string, unknown> = {}) {
  return { ...position(), createdAt: NOW, updatedAt: NOW, ...overrides };
}

function jobLevel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-level-001',
    tenantId: tenant.tenantId,
    code: 'P5',
    name: '资深',
    track: 'professional',
    rank: 5,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function jobLevelRecord(overrides: Record<string, unknown> = {}) {
  return { ...jobLevel(), createdAt: NOW, updatedAt: NOW, ...overrides };
}

describe('DepartmentRepository', () => {
  it('读取、树查询、全量与批量查询均强制可信租户并传播事务', async () => {
    const tenantContext = context();
    const byIdQuery = query(departmentRecord());
    const findOne = vi.fn()
      .mockReturnValueOnce(byIdQuery)
      .mockReturnValueOnce(query(null));
    const find = vi.fn()
      .mockReturnValueOnce(query([departmentRecord()]))
      .mockReturnValueOnce(query([departmentRecord()]))
      .mockReturnValueOnce(query([departmentRecord()]));
    const repository = new DepartmentRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findById('department-001', session))).resolves.toEqual(department());
    expect(byIdQuery.session).toHaveBeenCalledWith(session);
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findChildren(null, session))).resolves.toEqual([department()]);
    await expect(run(tenantContext, () => repository.findAll())).resolves.toEqual([department()]);
    await expect(run(tenantContext, () =>
      repository.findByIds(['department-001'], session))).resolves.toEqual([department()]);
    expect(find.mock.calls.every((call) =>
      JSON.stringify(call).includes(tenant.tenantId))).toBe(true);
  });

  it('新增和替换转换日期并拒绝跨租户及版本冲突', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new DepartmentRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(department() as never, session));
    await run(tenantContext, () => repository.replace(
      department({ name: '研发部', version: 2 }) as never,
      1,
      session,
    ));
    expect(JSON.stringify(create.mock.calls)).toContain(NOW.toISOString());
    await expect(run(tenantContext, () => repository.replace(
      department() as never,
      1,
      session,
    ))).rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      department({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('EmployeeRepository', () => {
  it('读取部门员工及全部员工时复制数组并传播可选事务', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(employeeRecord()))
      .mockReturnValueOnce(query(null));
    const find = vi.fn()
      .mockReturnValueOnce(query([employeeRecord()]))
      .mockReturnValueOnce(query([employeeRecord()]));
    const repository = new EmployeeRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findById('employee-001', session))).resolves.toEqual(employee());
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findByDepartment('department-001'))).resolves.toEqual([employee()]);
    await expect(run(tenantContext, () =>
      repository.findAll(session))).resolves.toEqual([employee()]);
  });

  it('新增和替换员工复制组织数组并检测租户与版本竞争', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new EmployeeRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(employee() as never, session));
    await run(tenantContext, () => repository.replace(
      employee({ departmentIds: ['department-002'], version: 2 }) as never,
      1,
      session,
    ));
    expect(JSON.stringify(updateOne.mock.calls)).toContain('department-002');
    await expect(run(tenantContext, () =>
      repository.replace(employee() as never, 1, session)))
      .rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      employee({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('PersonRepository', () => {
  it('按候选人、标识、批量与生日投影读取并处理空结果和空盲索引', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(personRecord()))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(personRecord({
        birthdayEvidenceId: 'birthday-evidence-001',
        birthdayAttestedAt: LATER,
      })))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(personRecord()))
      .mockReturnValueOnce(query(personRecord({ birthdayBlindIndexes: ['blind-001'] })));
    const find = vi.fn().mockReturnValue(query([personRecord()]));
    const repository = new PersonRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findBySourceCandidateId('candidate-001', session)))
      .resolves.toEqual(person());
    await expect(run(tenantContext, () =>
      repository.findBySourceCandidateId('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () => repository.findById('person-001')))
      .resolves.toMatchObject({ birthdayAttestedAt: LATER.toISOString() });
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findBirthdayProjectionById('person-001'))).resolves.toMatchObject({
      birthdayBlindIndexes: [],
    });
    await expect(run(tenantContext, () =>
      repository.findBirthdayProjectionById('person-001', session))).resolves.toMatchObject({
      birthdayBlindIndexes: ['blind-001'],
    });
    await expect(run(tenantContext, () =>
      repository.findByIds(['person-001'], session))).resolves.toEqual([person()]);
  });

  it('新增和生日证明更新覆盖空值、日期、冲突及跨租户', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new PersonRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(person() as never, session));
    await run(tenantContext, () => repository.attestBirthday(
      person({ version: 2 }) as never,
      [],
      1,
      session,
    ));
    await run(tenantContext, () => repository.attestBirthday(
      person({
        birthdayEvidenceId: 'birthday-evidence-001',
        birthdayAttestedAt: LATER.toISOString(),
        version: 2,
      }) as never,
      ['blind-001'],
      1,
      session,
    ));
    expect(JSON.stringify(updateOne.mock.calls[1])).toContain(LATER.toISOString());
    await expect(run(tenantContext, () => repository.attestBirthday(
      person() as never,
      [],
      1,
      session,
    ))).rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      person({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('EmploymentRepository', () => {
  it('覆盖全部劳动关系读取方法、空结果、重叠区间和事务传播', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(employmentRecord()))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(employmentRecord()))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(employmentRecord()))
      .mockReturnValueOnce(query(null));
    const find = vi.fn()
      .mockReturnValueOnce(query([employmentRecord()]))
      .mockReturnValueOnce(query([employmentRecord()]))
      .mockReturnValueOnce(query([employmentRecord()]));
    const repository = new EmploymentRepository(
      tenantContext,
      { findOne, find } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findByOnboardingInstanceId('onboarding-001', session)))
      .resolves.toEqual(employment());
    await expect(run(tenantContext, () =>
      repository.findByOnboardingInstanceId('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () => repository.findById('employment-001')))
      .resolves.toEqual(employment());
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findOpenByEmployeeId('employee-001', session))).resolves.toEqual(employment());
    await expect(run(tenantContext, () =>
      repository.findOpenByEmployeeId('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findByPersonId('person-001', session))).resolves.toEqual([employment()]);
    await expect(run(tenantContext, () => repository.findAll())).resolves.toEqual([employment()]);
    await expect(run(tenantContext, () => repository.findOverlappingByEmployeeIds(
      ['employee-001'],
      '2026-07-01',
      '2026-07-31',
      session,
    ))).resolves.toEqual([employment()]);
  });

  it('新增和替换劳动关系检测跨租户与并发冲突', async () => {
    const tenantContext = context();
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new EmploymentRepository(
      tenantContext,
      { create, updateOne } as never,
    );
    await run(tenantContext, () => repository.insert(employment() as never, session));
    await run(tenantContext, () => repository.replace(employment({
      status: 'terminated',
      effectiveTo: '2026-07-31',
      terminationCareCaseId: 'care-case-001',
      version: 2,
    }) as never, 1, session));
    await expect(run(tenantContext, () =>
      repository.replace(employment() as never, 1, session)))
      .rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      employment({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('EmployeeNumberSequenceRepository', () => {
  it('事务内原子分配年度工号并在数据库未返回记录时失败', async () => {
    const tenantContext = context();
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(query({ lastValue: 42 }))
      .mockReturnValueOnce(query(null));
    const repository = new EmployeeNumberSequenceRepository(
      tenantContext,
      { findOneAndUpdate } as never,
    );
    await expect(run(tenantContext, () => repository.next(2026, session))).resolves.toBe(42);
    await expect(run(tenantContext, () => repository.next(2026, session)))
      .rejects.toThrow('工号序列分配失败');
  });
});

describe('PositionRepository 与 JobLevelRepository', () => {
  it('职位读取、批量读取、新增替换和失败分支均强制租户', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(positionRecord()))
      .mockReturnValueOnce(query(null));
    const find = vi.fn().mockReturnValue(query([positionRecord()]));
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new PositionRepository(
      tenantContext,
      { findOne, find, create, updateOne } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findById('position-001', session))).resolves.toEqual(position());
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await expect(run(tenantContext, () =>
      repository.findByIds(['position-001'], session))).resolves.toEqual([position()]);
    await run(tenantContext, () => repository.insert(position() as never, session));
    await run(tenantContext, () => repository.replace(
      position({ name: '高级工程师', version: 2 }) as never,
      1,
      session,
    ));
    await expect(run(tenantContext, () =>
      repository.replace(position() as never, 1, session)))
      .rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      position({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });

  it('职级读取、新增替换和失败分支均强制租户', async () => {
    const tenantContext = context();
    const findOne = vi.fn()
      .mockReturnValueOnce(query(jobLevelRecord()))
      .mockReturnValueOnce(query(null));
    const create = vi.fn().mockResolvedValue([]);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new JobLevelRepository(
      tenantContext,
      { findOne, create, updateOne } as never,
    );
    await expect(run(tenantContext, () =>
      repository.findById('job-level-001', session))).resolves.toEqual(jobLevel());
    await expect(run(tenantContext, () => repository.findById('missing'))).resolves.toBeNull();
    await run(tenantContext, () => repository.insert(jobLevel() as never, session));
    await run(tenantContext, () => repository.replace(
      jobLevel({ rank: 6, version: 2 }) as never,
      1,
      session,
    ));
    await expect(run(tenantContext, () =>
      repository.replace(jobLevel() as never, 1, session)))
      .rejects.toBeInstanceOf(OrgWriteConflictError);
    await expect(run(tenantContext, () => repository.insert(
      jobLevel({ tenantId: 'tenant-other' }) as never,
      session,
    ))).rejects.toThrow('拒绝跨租户实体');
  });
});

describe('组织仓储可选事务分支', () => {
  it('同一读取契约同时支持事务内和普通只读调用', async () => {
    const tenantContext = context();

    const departmentFind = vi.fn()
      .mockReturnValueOnce(query([departmentRecord()]))
      .mockReturnValueOnce(query([departmentRecord()]));
    const departments = new DepartmentRepository(
      tenantContext,
      { find: departmentFind } as never,
    );
    await run(tenantContext, () => departments.findChildren(null));
    await run(tenantContext, () => departments.findAll(session));

    const employees = new EmployeeRepository(
      tenantContext,
      { find: vi.fn().mockReturnValue(query([employeeRecord()])) } as never,
    );
    await run(tenantContext, () => employees.findAll());

    const personFindOne = vi.fn()
      .mockReturnValueOnce(query(personRecord()))
      .mockReturnValueOnce(query(null));
    const persons = new PersonRepository(
      tenantContext,
      {
        findOne: personFindOne,
        find: vi.fn().mockReturnValue(query([personRecord()])),
      } as never,
    );
    await run(tenantContext, () => persons.findById('person-001', session));
    await run(tenantContext, () => persons.findBirthdayProjectionById('missing'));
    await run(tenantContext, () => persons.findByIds(['person-001']));

    const employmentFindOne = vi.fn().mockReturnValue(query(employmentRecord()));
    const employmentFind = vi.fn()
      .mockReturnValueOnce(query([employmentRecord()]))
      .mockReturnValueOnce(query([employmentRecord()]))
      .mockReturnValueOnce(query([employmentRecord()]));
    const employments = new EmploymentRepository(
      tenantContext,
      { findOne: employmentFindOne, find: employmentFind } as never,
    );
    await run(tenantContext, () => employments.findById('employment-001', session));
    await run(tenantContext, () => employments.findByPersonId('person-001'));
    await run(tenantContext, () => employments.findAll(session));
    await run(tenantContext, () => employments.findOverlappingByEmployeeIds(
      ['employee-001'],
      '2026-07-01',
      '2026-07-31',
    ));
  });
});
