import { describe, expect, it } from 'vitest';

import {
  createEmployee,
  transitionEmployeeStatus,
  updateEmployee,
  type Employee,
} from './employee.js';
import { OrgDomainError } from './org.errors.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

function makeEmployee(): Employee {
  return createEmployee(
    {
      id: 'emp-1',
      tenantId: 'tenant-a',
      employeeNo: 'E1001',
      displayName: '张三',
      departmentIds: ['dept-1', 'dept-2'],
      primaryDepartmentId: 'dept-1',
      positionIds: ['pos-1'],
      jobLevelId: 'jl-3',
    },
    NOW,
  );
}

describe('createEmployee', () => {
  it('创建成功：默认 probation，version=1，部门集合去重', () => {
    const emp = makeEmployee();
    expect(emp.status).toBe('probation');
    expect(emp.version).toBe(1);
    const dup = createEmployee(
      {
        id: 'emp-2',
        tenantId: 'tenant-a',
        employeeNo: 'E1002',
        displayName: '李四',
        departmentIds: ['dept-1', 'dept-1'],
        primaryDepartmentId: 'dept-1',
      },
      NOW,
    );
    expect(dup.departmentIds).toEqual(['dept-1']);
  });

  it('非法工号命中白名单校验', () => {
    for (const employeeNo of ['E 1001', '工号1@', '']) {
      expect(() =>
        createEmployee(
          {
            id: 'e',
            tenantId: 'tenant-a',
            employeeNo,
            displayName: '张三',
            departmentIds: ['dept-1'],
            primaryDepartmentId: 'dept-1',
          },
          NOW,
        ),
      ).toThrowError(OrgDomainError);
    }
  });

  it('主部门不在部门集合中拒绝', () => {
    expect(() =>
      createEmployee(
        {
          id: 'e',
          tenantId: 'tenant-a',
          employeeNo: 'E1001',
          displayName: '张三',
          departmentIds: ['dept-1'],
          primaryDepartmentId: 'dept-9',
        },
        NOW,
      ),
    ).toThrowError(/primaryDepartmentId/);
  });

  it('部门集合为空拒绝', () => {
    expect(() =>
      createEmployee(
        {
          id: 'e',
          tenantId: 'tenant-a',
          employeeNo: 'E1001',
          displayName: '张三',
          departmentIds: [],
          primaryDepartmentId: 'dept-1',
        },
        NOW,
      ),
    ).toThrowError(OrgDomainError);
  });
});

describe('updateEmployee', () => {
  it('更新主部门：必须同时属于新的部门集合，版本递增', () => {
    const emp = makeEmployee();
    const updated = updateEmployee(
      emp,
      { tenantId: 'tenant-a', departmentIds: ['dept-2', 'dept-3'], primaryDepartmentId: 'dept-2' },
      LATER,
    );
    expect(updated.primaryDepartmentId).toBe('dept-2');
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe(LATER.toISOString());
  });

  it('更新后主部门不在部门集合中拒绝', () => {
    const emp = makeEmployee();
    expect(() =>
      updateEmployee(emp, { tenantId: 'tenant-a', departmentIds: ['dept-9'] }, LATER),
    ).toThrowError(/primaryDepartmentId/);
  });

  it('跨租户修改被拒绝', () => {
    const emp = makeEmployee();
    expect(() =>
      updateEmployee(emp, { tenantId: 'tenant-b', displayName: '越权' }, LATER),
    ).toThrowError(/跨租户/);
  });

  it('禁止通过 updateEmployee 直接改状态，必须显式迁移', () => {
    const emp = makeEmployee();
    expect(() =>
      updateEmployee(emp, { tenantId: 'tenant-a', status: 'active' }, LATER),
    ).toThrowError(/transitionEmployeeStatus/);
  });
});

describe('transitionEmployeeStatus', () => {
  it('probation → active 合法，版本递增', () => {
    const emp = makeEmployee();
    const active = transitionEmployeeStatus(emp, 'active', LATER);
    expect(active.status).toBe('active');
    expect(active.version).toBe(2);
  });

  it('非法迁移被拒绝：probation → suspended', () => {
    const emp = makeEmployee();
    expect(() => transitionEmployeeStatus(emp, 'suspended', LATER)).toThrowError(
      /不允许/,
    );
  });

  it('active → suspended → active 合法往返', () => {
    const active = transitionEmployeeStatus(makeEmployee(), 'active', NOW);
    const suspended = transitionEmployeeStatus(active, 'suspended', NOW);
    const back = transitionEmployeeStatus(suspended, 'active', NOW);
    expect(back.status).toBe('active');
    expect(back.version).toBe(4);
  });

  it('离职不可逆：terminated 后任何迁移都拒绝', () => {
    const active = transitionEmployeeStatus(makeEmployee(), 'active', NOW);
    const terminated = transitionEmployeeStatus(active, 'terminated', NOW);
    expect(terminated.status).toBe('terminated');
    for (const next of ['probation', 'active', 'suspended'] as const) {
      expect(() => transitionEmployeeStatus(terminated, next, LATER)).toThrowError(
        /不可逆/,
      );
    }
  });

  it('terminated 自身重复迁移同样拒绝', () => {
    const active = transitionEmployeeStatus(makeEmployee(), 'active', NOW);
    const terminated = transitionEmployeeStatus(active, 'terminated', NOW);
    expect(() => transitionEmployeeStatus(terminated, 'terminated', LATER)).toThrowError(
      /不可逆/,
    );
  });
});
