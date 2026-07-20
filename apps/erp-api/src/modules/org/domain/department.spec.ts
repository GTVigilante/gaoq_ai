import { describe, expect, it } from 'vitest';

import {
  createDepartment,
  updateDepartment,
  type Department,
} from './department.js';
import { OrgDomainError } from './org.errors.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

function makeDepartment(): Department {
  return createDepartment(
    {
      id: 'dept-1',
      tenantId: 'tenant-a',
      code: 'HR',
      name: '人力资源部',
      parentId: null,
      sortOrder: 1,
    },
    NOW,
  );
}

describe('createDepartment', () => {
  it('创建成功：默认 active，version=1，时间戳注入', () => {
    const dept = makeDepartment();
    expect(dept.status).toBe('active');
    expect(dept.version).toBe(1);
    expect(dept.createdAt).toBe(NOW.toISOString());
    expect(dept.updatedAt).toBe(NOW.toISOString());
    expect(dept.managerId).toBeNull();
  });

  it('非法编码命中白名单校验：空格、符号、超长均拒绝', () => {
    for (const code of ['HR DEP', 'HR@01', 'a'.repeat(33), '-ABC', '']) {
      expect(() =>
        createDepartment(
          { id: 'd', tenantId: 'tenant-a', code, name: '部门' },
          NOW,
        ),
      ).toThrowError(OrgDomainError);
    }
  });

  it('名称长度校验：空名与超长名拒绝', () => {
    expect(() =>
      createDepartment(
        { id: 'd', tenantId: 'tenant-a', code: 'HR', name: '   ' },
        NOW,
      ),
    ).toThrowError(OrgDomainError);
    expect(() =>
      createDepartment(
        { id: 'd', tenantId: 'tenant-a', code: 'HR', name: '很'.repeat(65) },
        NOW,
      ),
    ).toThrowError(OrgDomainError);
  });

  it('创建时禁止 self-parent', () => {
    expect(() =>
      createDepartment(
        { id: 'dept-1', tenantId: 'tenant-a', code: 'HR', name: '部门', parentId: 'dept-1' },
        NOW,
      ),
    ).toThrowError(/自身/);
  });

  it('空 tenantId 拒绝', () => {
    expect(() =>
      createDepartment({ id: 'd', tenantId: '  ', code: 'HR', name: '部门' }, NOW),
    ).toThrowError(OrgDomainError);
  });
});

describe('updateDepartment', () => {
  it('更新成功：版本递增、updatedAt 刷新、createdAt 不变', () => {
    const dept = makeDepartment();
    const updated = updateDepartment(
      dept,
      { tenantId: 'tenant-a', name: '人事行政部', sortOrder: 2 },
      LATER,
    );
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('人事行政部');
    expect(updated.updatedAt).toBe(LATER.toISOString());
    expect(updated.createdAt).toBe(NOW.toISOString());
    expect(dept.version).toBe(1);
  });

  it('跨租户修改被拒绝', () => {
    const dept = makeDepartment();
    expect(() =>
      updateDepartment(dept, { tenantId: 'tenant-b', name: '越权改名' }, LATER),
    ).toThrowError(/跨租户/);
  });

  it('更新时禁止 self-parent', () => {
    const dept = makeDepartment();
    expect(() =>
      updateDepartment(dept, { tenantId: 'tenant-a', parentId: 'dept-1' }, LATER),
    ).toThrowError(/自身/);
  });

  it('非法状态与非法排序被拒绝', () => {
    const dept = makeDepartment();
    expect(() =>
      updateDepartment(
        dept,
        // 构造非法状态以验证运行时校验
        { tenantId: 'tenant-a', status: 'archived' as never },
        LATER,
      ),
    ).toThrowError(OrgDomainError);
    expect(() =>
      updateDepartment(dept, { tenantId: 'tenant-a', sortOrder: -1 }, LATER),
    ).toThrowError(OrgDomainError);
  });
});
