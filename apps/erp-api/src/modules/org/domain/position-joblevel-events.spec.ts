import { describe, expect, it } from 'vitest';

import { createDepartment } from './department.js';
import { createEmployee, transitionEmployeeStatus } from './employee.js';
import { createJobLevel, updateJobLevel } from './job-level.js';
import { OrgDomainError } from './org.errors.js';
import {
  buildDepartmentCreatedEvent,
  buildDepartmentUpdatedEvent,
  buildEmployeeCreatedEvent,
  buildEmployeeStatusChangedEvent,
  buildJobLevelCreatedEvent,
  type OrgDomainEvent,
} from './org-events.js';
import { createPosition, updatePosition } from './position.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

describe('Position', () => {
  it('创建与更新：版本递增', () => {
    const pos = createPosition(
      { id: 'pos-1', tenantId: 'tenant-a', code: 'BACKEND', name: '后端工程师' },
      NOW,
    );
    expect(pos.status).toBe('active');
    const updated = updatePosition(pos, { tenantId: 'tenant-a', status: 'inactive' }, LATER);
    expect(updated.version).toBe(2);
    expect(updated.status).toBe('inactive');
  });

  it('非法编码与跨租户修改被拒绝', () => {
    expect(() =>
      createPosition(
        { id: 'p', tenantId: 'tenant-a', code: '后端 岗', name: '后端' },
        NOW,
      ),
    ).toThrowError(OrgDomainError);
    const pos = createPosition(
      { id: 'p', tenantId: 'tenant-a', code: 'BE', name: '后端' },
      NOW,
    );
    expect(() => updatePosition(pos, { tenantId: 'tenant-b', name: '越权' }, LATER)).toThrowError(
      /跨租户/,
    );
  });
});

describe('JobLevel', () => {
  it('创建：track 与 rank 校验通过', () => {
    const jl = createJobLevel(
      { id: 'jl-1', tenantId: 'tenant-a', code: 'P5', name: '资深工程师', track: 'professional', rank: 5 },
      NOW,
    );
    expect(jl.track).toBe('professional');
    expect(jl.rank).toBe(5);
    expect(jl.version).toBe(1);
  });

  it('非法 track 与越界 rank 被拒绝', () => {
    expect(() =>
      createJobLevel(
        { id: 'j', tenantId: 'tenant-a', code: 'P5', name: '职级', track: 'sales' as never, rank: 5 },
        NOW,
      ),
    ).toThrowError(OrgDomainError);
    for (const rank of [0, -1, 31, 1.5]) {
      expect(() =>
        createJobLevel(
          { id: 'j', tenantId: 'tenant-a', code: 'P5', name: '职级', track: 'management', rank },
          NOW,
        ),
      ).toThrowError(OrgDomainError);
    }
  });

  it('更新：版本递增且跨租户拒绝', () => {
    const jl = createJobLevel(
      { id: 'j', tenantId: 'tenant-a', code: 'M2', name: '经理', track: 'management', rank: 2 },
      NOW,
    );
    const updated = updateJobLevel(jl, { tenantId: 'tenant-a', rank: 3 }, LATER);
    expect(updated.version).toBe(2);
    expect(updated.rank).toBe(3);
    expect(() => updateJobLevel(jl, { tenantId: 'tenant-b', rank: 3 }, LATER)).toThrowError(
      /跨租户/,
    );
  });
});

describe('组织领域事件', () => {
  it('department.created 信封与载荷正确', () => {
    const dept = createDepartment(
      { id: 'dept-1', tenantId: 'tenant-a', code: 'HR', name: '人力资源部' },
      NOW,
    );
    const event = buildDepartmentCreatedEvent(dept, NOW);
    expect(event.type).toBe('department.created');
    expect(event.tenantId).toBe('tenant-a');
    expect(event.aggregateId).toBe('dept-1');
    expect(event.version).toBe(1);
    expect(event.payload).toEqual({
      code: 'HR',
      name: '人力资源部',
      status: 'active',
      parentId: null,
      managerId: null,
      sortOrder: 0,
    });
  });

  it('employee.created 载荷仅含非敏感字段', () => {
    const emp = createEmployee(
      {
        id: 'emp-1',
        tenantId: 'tenant-a',
        employeeNo: 'E1001',
        displayName: '张三',
        departmentIds: ['dept-1'],
        primaryDepartmentId: 'dept-1',
      },
      NOW,
    );
    const event = buildEmployeeCreatedEvent(emp, NOW);
    expect(event.type).toBe('employee.created');
    const payload = event.payload as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(payload);
    for (const sensitive of ['phone', 'mobile', 'idCard', 'salary', 'bank']) {
      expect(serialized.toLowerCase()).not.toContain(sensitive.toLowerCase());
    }
    expect(Object.keys(payload).sort()).toEqual(
      [
        'departmentIds',
        'displayName',
        'employeeNo',
        'jobLevelId',
        'positionIds',
        'primaryDepartmentId',
        'status',
      ].sort(),
    );
  });

  it('employee.status_changed 记录 from/to 状态', () => {
    const emp = createEmployee(
      {
        id: 'emp-1',
        tenantId: 'tenant-a',
        employeeNo: 'E1001',
        displayName: '张三',
        departmentIds: ['dept-1'],
        primaryDepartmentId: 'dept-1',
      },
      NOW,
    );
    const active = transitionEmployeeStatus(emp, 'active', LATER);
    const event = buildEmployeeStatusChangedEvent(active, 'probation', LATER);
    expect(event.type).toBe('employee.status_changed');
    expect(event.version).toBe(2);
    expect(event.payload).toEqual({ fromStatus: 'probation', toStatus: 'active' });
  });

  it('job_level.created 事件纳入联合类型', () => {
    const jl = createJobLevel(
      { id: 'jl-1', tenantId: 'tenant-a', code: 'P5', name: '资深工程师', track: 'professional', rank: 5 },
      NOW,
    );
    const event: OrgDomainEvent = buildJobLevelCreatedEvent(jl, NOW);
    expect(event.type).toBe('job_level.created');
    expect(event.payload).toEqual({
      code: 'P5',
      name: '资深工程师',
      track: 'professional',
      rank: 5,
    });
  });

  it('事件快照不可变：后续修改源数组不影响 payload', () => {
    const emp = createEmployee(
      {
        id: 'emp-1',
        tenantId: 'tenant-a',
        employeeNo: 'E1001',
        displayName: '张三',
        departmentIds: ['dept-1'],
        primaryDepartmentId: 'dept-1',
      },
      NOW,
    );
    const event = buildEmployeeCreatedEvent(emp, NOW);
    (emp.departmentIds as string[]).push('dept-x');
    expect(event.payload.departmentIds).toEqual(['dept-1']);
  });

  it('department.updated 事件载荷携带最新快照', () => {
    const dept = createDepartment(
      { id: 'dept-1', tenantId: 'tenant-a', code: 'HR', name: '人力资源部' },
      NOW,
    );
    const renamed = { ...dept, name: '人事行政部', version: 2, updatedAt: LATER.toISOString() };
    const event: OrgDomainEvent = buildDepartmentUpdatedEvent(renamed, LATER);
    expect(event.type).toBe('department.updated');
    expect(event.version).toBe(2);
    expect(event.payload.name).toBe('人事行政部');
  });
});
