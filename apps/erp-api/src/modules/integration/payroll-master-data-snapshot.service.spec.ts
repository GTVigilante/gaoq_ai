import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type {
  DepartmentRepository,
  EmployeeRepository,
  EmploymentRepository,
} from '../org/persistence/org.repositories.js';
import { PayrollMasterDataSnapshotService } from './payroll-master-data-snapshot.service.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const context = (
  actorType: 'user' | 'service' | 'mcp_client' | 'system_job',
  tenantId: string,
): TenantContextService => ({
  getRequired: () => ({
    tenant: { tenantId, source: 'service_identity' },
    actor: {
      actorType,
      actorId: 'payroll-sync',
      tenantId,
      roleCodes: ['payroll-sync'],
      scopes: ['erp:payroll:master-data:read'],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }),
} as unknown as TenantContextService);

const department = (index: number) => ({
  id: `department-${String(index).padStart(3, '0')}`,
  tenantId: 'tenant-001',
  code: `D${String(index).padStart(3, '0')}`,
  name: `部门${index}`,
  status: 'active' as const,
  parentId: null,
  managerId: index === 1 ? 'employee-001' : null,
  sortOrder: index,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const employee = {
  id: 'employee-001',
  tenantId: 'tenant-001',
  employeeNo: 'GQ001',
  displayName: '测试员工',
  status: 'active' as const,
  departmentIds: ['department-001'],
  primaryDepartmentId: 'department-001',
  positionIds: [],
  jobLevelId: null,
  version: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const employment = {
  id: 'employment-001',
  tenantId: 'tenant-001',
  personId: 'person-001',
  employeeId: 'employee-001',
  onboardingInstanceId: null,
  status: 'active' as const,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const encodeCursor = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function fixture(options: {
  readonly actorType?: 'user' | 'service' | 'mcp_client' | 'system_job';
  readonly tenantId?: string;
  readonly departmentCount?: number;
} = {}) {
  const tenantId = options.tenantId ?? 'tenant-001';
  const departments = Array.from(
    { length: options.departmentCount ?? 1 },
    (_, index) => department(index + 1),
  );
  const findDepartments = vi.fn().mockResolvedValue(departments);
  const findEmployees = vi.fn().mockResolvedValue([employee]);
  const findEmployments = vi.fn().mockResolvedValue([employment]);
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new PayrollMasterDataSnapshotService(
    context(options.actorType ?? 'service', tenantId),
    { findAll: findDepartments } as unknown as DepartmentRepository,
    { findAll: findEmployees } as unknown as EmployeeRepository,
    { findAll: findEmployments } as unknown as EmploymentRepository,
    { record } as unknown as AuditService,
  );
  return {
    service,
    record,
    findDepartments,
    findEmployees,
    findEmployments,
    departments,
  };
}

describe('算薪组织主数据快照', () => {
  it.each(['service', 'mcp_client', 'system_job'] as const)(
    '允许可信 %s 身份读取脱敏快照并记录批量访问审计',
    async (actorType) => {
      const store = fixture({ actorType });

      const page = await store.service.page();

      expect(page).toMatchObject({
        contractVersion: '1.0.0',
        nextCursor: null,
        departments: [{
          departmentId: 'department-001',
          managerEmployeeId: 'employee-001',
        }],
        employees: [{
          employeeId: 'employee-001',
          displayName: '测试员工',
        }],
        employments: [{
          employmentId: 'employment-001',
          employeeId: 'employee-001',
        }],
      });
      expect(page.snapshotId).toBe(page.snapshotDigest);
      expect(page.snapshotDigest).toMatch(SHA256_PATTERN);
      expect(Number.isNaN(Date.parse(page.generatedAt))).toBe(false);
      expect(Object.isFrozen(page)).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/bank|idCard|taxId|mobile/i);
      expect(store.record).toHaveBeenCalledWith({
        action: 'integration.payroll_master_data.snapshot.read',
        resourceType: 'payroll_master_data_snapshot',
        resourceId: page.snapshotDigest,
        riskLevel: 'R1',
        outcome: 'success',
        metadata: {
          offset: 0,
          departmentCount: 1,
          employeeCount: 1,
          employmentCount: 1,
          hasNextPage: false,
        },
      });
      expect(JSON.stringify(store.record.mock.calls)).not.toContain('测试员工');
    },
  );

  it('在稳定实体顺序上按 200 条分页并审计精确页计数', async () => {
    const store = fixture({ departmentCount: 201 });

    const first = await store.service.page();
    expect(first.departments).toHaveLength(200);
    expect(first.employees).toHaveLength(0);
    expect(first.employments).toHaveLength(0);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.service.page(first.nextCursor ?? undefined);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.nextCursor).toBeNull();
    expect(second.departments.map((item) => item.departmentId))
      .toEqual(['department-201']);
    expect(second.employees.map((item) => item.employeeId))
      .toEqual(['employee-001']);
    expect(second.employments.map((item) => item.employmentId))
      .toEqual(['employment-001']);
    expect(store.record).toHaveBeenLastCalledWith(expect.objectContaining({
      resourceId: first.snapshotId,
      metadata: {
        offset: 200,
        departmentCount: 1,
        employeeCount: 1,
        employmentCount: 1,
        hasNextPage: false,
      },
    }));
  });

  it('拒绝普通用户并且不读取仓储或写成功审计', async () => {
    const store = fixture({ actorType: 'user' });

    await expect(store.service.page()).rejects.toBeInstanceOf(ForbiddenException);

    expect(store.findDepartments).not.toHaveBeenCalled();
    expect(store.findEmployees).not.toHaveBeenCalled();
    expect(store.findEmployments).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('快照摘要绑定可信租户并拒绝跨租户游标重放', async () => {
    const tenantA = fixture({ tenantId: 'tenant-a', departmentCount: 201 });
    const tenantB = fixture({ tenantId: 'tenant-b', departmentCount: 201 });
    const firstA = await tenantA.service.page();
    const firstB = await tenantB.service.page();

    expect(firstA.snapshotId).not.toBe(firstB.snapshotId);
    await expect(tenantB.service.page(firstA.nextCursor ?? undefined))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('主数据变化后旧游标失败关闭并要求重新开始', async () => {
    const store = fixture({ departmentCount: 201 });
    const first = await store.service.page();
    store.findDepartments.mockResolvedValue([
      ...store.departments,
      department(202),
    ]);

    await expect(store.service.page(first.nextCursor ?? undefined))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('审计不可用时批量敏感读取失败关闭', async () => {
    const store = fixture();
    const auditFailure = new Error('audit unavailable');
    store.record.mockRejectedValue(auditFailure);

    await expect(store.service.page()).rejects.toBe(auditFailure);
  });

  it('仓储读取失败时不写成功审计', async () => {
    const store = fixture();
    const repositoryFailure = new Error('repository unavailable');
    store.findEmployees.mockRejectedValue(repositoryFailure);

    await expect(store.service.page()).rejects.toBe(repositoryFailure);
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    ['空字符串', ''],
    ['非 Base64URL 字符', '***'],
    ['带填充字符', `${encodeCursor({ digest: '0'.repeat(64), offset: 200 })}=`],
    ['超长值', 'A'.repeat(513)],
    ['数组载荷', encodeCursor(['0'.repeat(64), 200])],
    ['缺少字段', encodeCursor({ digest: '0'.repeat(64) })],
    ['额外字段', encodeCursor({ digest: '0'.repeat(64), offset: 200, extra: true })],
    ['摘要类型错误', encodeCursor({ digest: 1, offset: 200 })],
    ['摘要格式错误', encodeCursor({ digest: 'invalid', offset: 200 })],
    ['起始偏移', encodeCursor({ digest: '0'.repeat(64), offset: 0 })],
    ['负偏移', encodeCursor({ digest: '0'.repeat(64), offset: -200 })],
    ['小数偏移', encodeCursor({ digest: '0'.repeat(64), offset: 200.5 })],
    ['非页边界偏移', encodeCursor({ digest: '0'.repeat(64), offset: 201 })],
    ['终止偏移', encodeCursor({ digest: '0'.repeat(64), offset: 400 })],
  ])('拒绝%s游标', async (_name, cursor) => {
    const store = fixture({ departmentCount: 201 });

    await expect(store.service.page(cursor)).rejects.toBeInstanceOf(BadRequestException);
    expect(store.record).not.toHaveBeenCalled();
  });
});
