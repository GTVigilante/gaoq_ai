import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AccessProfileRepository,
  AccessProfileSnapshot,
} from '../../identity/access-profile.repository.js';
import type { Department } from '../../org/domain/department.js';
import type { Employee, EmployeeStatus } from '../../org/domain/employee.js';
import type { DepartmentRepository, EmployeeRepository } from '../../org/persistence/org.repositories.js';
import {
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  snapshotApprovalTemplate,
  type ApprovalFormField,
  type ApprovalProcessNode,
  type ApprovalTemplateDefinition,
  type ApprovalTemplateSnapshot,
} from '../domain/template.js';
import { ApprovalActorResolverService } from './approval-actor-resolver.service.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;
const TENANT_ID = 'tenant-001';
const INITIATOR_ACTOR_ID = 'initiator-actor';
const INITIATOR_EMPLOYEE_ID = 'employee-001';
const INITIATOR_DEPARTMENT_ID = 'department-001';

const AMOUNT_FIELD: ApprovalFormField = {
  key: 'amount',
  label: '金额',
  type: 'money_minor',
  required: true,
  sensitivity: 'L2',
};

function approvalSnapshot(
  nodes: readonly ApprovalProcessNode[] = [
    {
      id: 'manager',
      name: '部门负责人',
      type: 'approval',
      approvalMode: 'all',
      resolver: { type: 'initiator_manager' },
    },
    {
      id: 'finance',
      name: '财务',
      type: 'approval',
      approvalMode: 'any',
      resolver: { type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'tenant' },
      condition: { op: 'gte', field: 'amount', value: 100_00 },
    },
  ],
  fields: readonly ApprovalFormField[] = [AMOUNT_FIELD],
): ApprovalTemplateSnapshot {
  const definition: ApprovalTemplateDefinition = { fields, nodes };
  const draft = createApprovalTemplateDraft({
    id: 'template-001',
    tenantId: TENANT_ID,
    code: 'EXPENSE',
    name: '费用审批',
    riskLevel: 'R2',
    definition,
    actorId: 'editor-001',
  }, NOW);
  return snapshotApprovalTemplate(publishApprovalTemplate(draft, {
    tenantId: TENANT_ID,
    expectedVersion: 1,
    approverId: 'publisher-001',
  }, NOW));
}

function profile(
  actorId: string,
  employeeId: string,
  overrides: Partial<AccessProfileSnapshot> = {},
): AccessProfileSnapshot {
  return {
    tenantId: TENANT_ID,
    actorId,
    employeeId,
    status: 'active',
    roleCodes: [],
    scopes: [],
    departmentIds: [INITIATOR_DEPARTMENT_ID],
    version: 1,
    ...overrides,
  };
}

function employee(
  id: string,
  status: EmployeeStatus = 'active',
  overrides: Partial<Employee> = {},
): Employee {
  return {
    id,
    tenantId: TENANT_ID,
    employeeNo: `NO-${id}`,
    displayName: id,
    status,
    departmentIds: [INITIATOR_DEPARTMENT_ID],
    primaryDepartmentId: INITIATOR_DEPARTMENT_ID,
    positionIds: [],
    jobLevelId: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function department(
  id: string,
  managerId: string | null,
  overrides: Partial<Department> = {},
): Department {
  return {
    id,
    tenantId: TENANT_ID,
    code: id,
    name: id,
    status: 'active',
    parentId: null,
    managerId,
    sortOrder: 0,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fixture() {
  const profilesByActor = new Map<string, AccessProfileSnapshot>([
    [
      INITIATOR_ACTOR_ID,
      profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID),
    ],
    ['manager-actor', profile('manager-actor', 'manager-employee')],
    ['finance-actor', profile('finance-actor', 'finance-employee')],
  ]);
  const actorByEmployee = new Map<string, string>([
    ['manager-employee', 'manager-actor'],
    ['finance-employee', 'finance-actor'],
  ]);
  const employeesById = new Map<string, Employee>([
    [INITIATOR_EMPLOYEE_ID, employee(INITIATOR_EMPLOYEE_ID)],
    ['manager-employee', employee('manager-employee')],
    ['finance-employee', employee('finance-employee')],
  ]);
  const departmentsById = new Map<string, Department>([
    [
      INITIATOR_DEPARTMENT_ID,
      department(INITIATOR_DEPARTMENT_ID, 'manager-employee'),
    ],
  ]);
  const profiles = {
    resolveActive: vi.fn((_tenantId: string, actorId: string) =>
      Promise.resolve(profilesByActor.get(actorId) ?? null)),
    findActorIdByEmployee: vi.fn((_tenantId: string, employeeId: string) =>
      Promise.resolve(actorByEmployee.get(employeeId) ?? null)),
    findActiveByRoles: vi.fn(() => Promise.resolve([
      profile('finance-actor', 'finance-employee'),
    ])),
  };
  const employees = {
    findById: vi.fn((id: string) => Promise.resolve(employeesById.get(id) ?? null)),
  };
  const departments = {
    findById: vi.fn((id: string) => Promise.resolve(departmentsById.get(id) ?? null)),
  };
  const resolver = new ApprovalActorResolverService(
    { getTenantRequired: () => ({ tenantId: TENANT_ID }) } as unknown as TenantContextService,
    profiles as unknown as AccessProfileRepository,
    employees as unknown as EmployeeRepository,
    departments as unknown as DepartmentRepository,
  );
  return {
    resolver,
    profiles,
    employees,
    departments,
    profilesByActor,
    actorByEmployee,
    employeesById,
    departmentsById,
  };
}

async function expectResolutionFailure(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: 'APPROVAL_ACTOR_RESOLUTION_FAILED' });
}

describe('ApprovalActorResolverService', () => {
  it('只使用可信租户上下文，并冻结条件命中的部门负责人和角色主体', async () => {
    const store = fixture();

    const result = await store.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 200_00 },
      SESSION,
    );

    expect(result).toEqual([
      { nodeId: 'manager', actorIds: ['manager-actor'] },
      { nodeId: 'finance', actorIds: ['finance-actor'] },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.actorIds)).toBe(true);
    expect(store.profiles.findActiveByRoles).toHaveBeenCalledWith(
      TENANT_ID,
      ['FINANCE_APPROVER'],
      null,
      SESSION,
    );
  });

  it('条件未命中的节点不触发角色查询', async () => {
    const store = fixture();
    const result = await store.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 50_00 },
      SESSION,
    );

    expect(result.map((node) => node.nodeId)).toEqual(['manager']);
    expect(store.profiles.findActiveByRoles).not.toHaveBeenCalled();
  });

  it('部门范围角色解析只保留在职员工并按主体标识排序', async () => {
    const store = fixture();
    store.profiles.findActiveByRoles.mockResolvedValueOnce([
      profile('z-actor', 'z-employee'),
      profile('a-actor', 'a-employee'),
      profile('inactive-actor', 'inactive-employee'),
    ]);
    store.employeesById.set('z-employee', employee('z-employee', 'probation'));
    store.employeesById.set('a-employee', employee('a-employee'));
    store.employeesById.set('inactive-employee', employee('inactive-employee', 'suspended'));
    const scopedSnapshot = approvalSnapshot([{
      id: 'department-role',
      name: '部门角色',
      type: 'approval',
      approvalMode: 'all',
      resolver: {
        type: 'roles',
        roleCodes: ['DEPARTMENT_APPROVER'],
        scope: 'initiator_department',
      },
    }]);

    const result = await store.resolver.resolve(
      scopedSnapshot,
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    );

    expect(result[0]?.actorIds).toEqual(['a-actor', 'z-actor']);
    expect(store.profiles.findActiveByRoles).toHaveBeenCalledWith(
      TENANT_ID,
      ['DEPARTMENT_APPROVER'],
      [INITIATOR_DEPARTMENT_ID],
      SESSION,
    );
  });

  it('固定员工解析拒绝失效映射，并保留有效员工主体', async () => {
    const store = fixture();
    store.employeesById.set('probation-employee', employee('probation-employee', 'probation'));
    store.employeesById.set('terminated-employee', employee('terminated-employee', 'terminated'));
    store.actorByEmployee.set('probation-employee', 'probation-actor');
    store.profilesByActor.set(
      'probation-actor',
      profile('probation-actor', 'probation-employee'),
    );
    const fixedSnapshot = approvalSnapshot([{
      id: 'fixed',
      name: '固定审批人',
      type: 'approval',
      approvalMode: 'all',
      resolver: {
        type: 'employees',
        employeeIds: ['probation-employee', 'terminated-employee', 'missing-employee'],
      },
    }]);

    const result = await store.resolver.resolve(
      fixedSnapshot,
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    );

    expect(result[0]?.actorIds).toEqual(['probation-actor']);
  });

  it('按部门字段解析负责人，并允许抄送节点在部门无负责人时为空', async () => {
    const store = fixture();
    store.departmentsById.set(
      'selected-department',
      department('selected-department', 'manager-employee'),
    );
    store.departmentsById.set(
      'empty-department',
      department('empty-department', null),
    );
    const departmentField: ApprovalFormField = {
      key: 'department_id',
      label: '部门',
      type: 'department',
      required: true,
      sensitivity: 'L2',
    };
    const selected = await store.resolver.resolve(
      approvalSnapshot([{
        id: 'selected-manager',
        name: '所选部门负责人',
        type: 'approval',
        approvalMode: 'all',
        resolver: { type: 'department_manager', departmentField: 'department_id' },
      }], [departmentField]),
      INITIATOR_ACTOR_ID,
      { department_id: 'selected-department' },
      SESSION,
    );
    const empty = await store.resolver.resolve(
      approvalSnapshot([{
        id: 'copy-manager',
        name: '抄送部门负责人',
        type: 'copy',
        resolver: { type: 'department_manager', departmentField: 'department_id' },
      }, {
        id: 'fallback',
        name: '固定审批',
        type: 'approval',
        approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      }], [departmentField]),
      INITIATOR_ACTOR_ID,
      { department_id: 'empty-department' },
      SESSION,
    );

    expect(selected[0]?.actorIds).toEqual(['manager-actor']);
    expect(empty[0]?.actorIds).toEqual([]);
  });

  it('拒绝非法、缺失或停用的发起主体授权快照', async () => {
    const invalidActor = fixture();
    await expectResolutionFailure(invalidActor.resolver.resolve(
      approvalSnapshot(),
      'invalid actor',
      { amount: 1 },
      SESSION,
    ));
    expect(invalidActor.profiles.resolveActive).not.toHaveBeenCalled();

    for (const persisted of [
      null,
      profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID, { status: 'disabled' }),
      profile('different-actor', INITIATOR_EMPLOYEE_ID),
      profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID, { tenantId: 'tenant-002' }),
      profile(INITIATOR_ACTOR_ID, 'invalid employee'),
      profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID, {
        departmentIds: [INITIATOR_DEPARTMENT_ID, INITIATOR_DEPARTMENT_ID],
      }),
      profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID, { departmentIds: [] }),
    ] as const) {
      const store = fixture();
      store.profiles.resolveActive.mockResolvedValueOnce(persisted);
      await expectResolutionFailure(store.resolver.resolve(
        approvalSnapshot(),
        INITIATOR_ACTOR_ID,
        { amount: 1 },
        SESSION,
      ));
    }
  });

  it('拒绝缺失、非在职或受损的发起员工主数据', async () => {
    const cases: readonly (Employee | null)[] = [
      null,
      employee(INITIATOR_EMPLOYEE_ID, 'terminated'),
      employee(INITIATOR_EMPLOYEE_ID, 'suspended'),
      employee('different-employee'),
      employee(INITIATOR_EMPLOYEE_ID, 'active', { tenantId: 'tenant-002' }),
      employee(INITIATOR_EMPLOYEE_ID, 'active', { primaryDepartmentId: 'invalid department' }),
      employee(INITIATOR_EMPLOYEE_ID, 'invalid' as EmployeeStatus),
    ];
    for (const persisted of cases) {
      const store = fixture();
      store.employees.findById.mockResolvedValueOnce(persisted);
      await expectResolutionFailure(store.resolver.resolve(
        approvalSnapshot(),
        INITIATOR_ACTOR_ID,
        { amount: 1 },
        SESSION,
      ));
    }
  });

  it('拒绝角色查询返回的跨租户、重复或受损授权映射', async () => {
    const invalidSets: readonly AccessProfileSnapshot[][] = [
      [profile('actor-001', 'employee-101', { tenantId: 'tenant-002' })],
      [profile('actor-001', 'employee-101', { status: 'disabled' })],
      [profile('invalid actor', 'employee-101')],
      [profile('actor-001', 'invalid employee')],
      [profile('actor-001', 'employee-101', {
        departmentIds: ['department-001', 'department-001'],
      })],
      [profile('actor-001', 'employee-101'), profile('actor-001', 'employee-102')],
      [profile('actor-001', 'employee-101'), profile('actor-002', 'employee-101')],
    ];
    for (const profiles of invalidSets) {
      const store = fixture();
      store.profiles.findActiveByRoles.mockResolvedValueOnce(profiles);
      await expectResolutionFailure(store.resolver.resolve(
        approvalSnapshot(),
        INITIATOR_ACTOR_ID,
        { amount: 200_00 },
        SESSION,
      ));
    }
  });

  it('拒绝单个角色节点解析超过一百个有效主体', async () => {
    const store = fixture();
    const profiles = Array.from({ length: 101 }, (_, index) => {
      const actorId = `actor-${index}`;
      const employeeId = `employee-${index + 100}`;
      store.employeesById.set(employeeId, employee(employeeId));
      return profile(actorId, employeeId);
    });
    store.profiles.findActiveByRoles.mockResolvedValueOnce(profiles);

    await expectResolutionFailure(store.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 200_00 },
      SESSION,
    ));
  });

  it('拒绝部门字段运行时漂移以及部门主数据污染', async () => {
    const field: ApprovalFormField = {
      key: 'department_id',
      label: '部门',
      type: 'department',
      required: true,
      sensitivity: 'L2',
    };
    const snapshot = approvalSnapshot([{
      id: 'department-manager',
      name: '部门负责人',
      type: 'approval',
      approvalMode: 'all',
      resolver: { type: 'department_manager', departmentField: 'department_id' },
    }], [field]);
    for (const value of [1, 'invalid department']) {
      const store = fixture();
      await expectResolutionFailure(store.resolver.resolve(
        snapshot,
        INITIATOR_ACTOR_ID,
        { department_id: value },
        SESSION,
      ));
    }
    for (const persisted of [
      department('different-department', 'manager-employee'),
      department('selected-department', 'manager-employee', { tenantId: 'tenant-002' }),
      department('selected-department', 'invalid manager'),
      department('selected-department', 'manager-employee', {
        status: 'invalid' as Department['status'],
      }),
    ]) {
      const store = fixture();
      store.departments.findById.mockResolvedValueOnce(persisted);
      await expectResolutionFailure(store.resolver.resolve(
        snapshot,
        INITIATOR_ACTOR_ID,
        { department_id: 'selected-department' },
        SESSION,
      ));
    }
  });

  it('审批节点未解析到负责人时失败关闭', async () => {
    const store = fixture();
    store.departmentsById.set(
      INITIATOR_DEPARTMENT_ID,
      department(INITIATOR_DEPARTMENT_ID, null, { status: 'inactive' }),
    );

    await expectResolutionFailure(store.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    ));
  });

  it('拒绝员工反查主体与当前有效授权快照发生漂移', async () => {
    const mismatch = fixture();
    mismatch.profilesByActor.set(
      'manager-actor',
      profile('manager-actor', 'different-employee'),
    );
    await expectResolutionFailure(mismatch.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    ));

    const invalidActor = fixture();
    invalidActor.profiles.findActorIdByEmployee.mockResolvedValueOnce('invalid actor');
    await expectResolutionFailure(invalidActor.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    ));

    const inactiveMapping = fixture();
    inactiveMapping.profiles.resolveActive
      .mockResolvedValueOnce(profile(INITIATOR_ACTOR_ID, INITIATOR_EMPLOYEE_ID))
      .mockResolvedValueOnce(null);
    await expectResolutionFailure(inactiveMapping.resolver.resolve(
      approvalSnapshot(),
      INITIATOR_ACTOR_ID,
      { amount: 1 },
      SESSION,
    ));
  });

  it('拒绝目标员工主数据跨租户、标识错位或非法状态', async () => {
    for (const persisted of [
      employee('manager-employee', 'active', { tenantId: 'tenant-002' }),
      employee('different-employee'),
      employee('manager-employee', 'invalid' as EmployeeStatus),
      employee('manager-employee', 'active', { primaryDepartmentId: 'invalid department' }),
    ]) {
      const store = fixture();
      store.employees.findById.mockImplementation((id: string) =>
        Promise.resolve(id === INITIATOR_EMPLOYEE_ID ? employee(INITIATOR_EMPLOYEE_ID) : persisted));
      await expectResolutionFailure(store.resolver.resolve(
        approvalSnapshot(),
        INITIATOR_ACTOR_ID,
        { amount: 1 },
        SESSION,
      ));
    }
  });
});
