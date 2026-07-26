import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type {
  DepartmentRepository,
  EmployeeRepository,
  EmploymentRepository,
} from '../org/persistence/org.repositories.js';
import { PayrollMasterDataSnapshotService } from './payroll-master-data-snapshot.service.js';

const context = (actorType: 'user' | 'service'): TenantContextService => ({
  getRequired: () => ({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorType,
      actorId: 'payroll-sync',
      tenantId: 'tenant-001',
      roleCodes: ['payroll-sync'],
      scopes: ['erp:payroll:master-data:read'],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }),
} as unknown as TenantContextService);

const createService = (actorType: 'user' | 'service' = 'service') =>
  new PayrollMasterDataSnapshotService(
    context(actorType),
    {
      findAll: vi.fn().mockResolvedValue([{
        id: 'department-001',
        code: 'D001',
        name: '人力资源部',
        status: 'active',
        parentId: null,
        managerId: 'employee-001',
        sortOrder: 0,
        version: 1,
      }]),
    } as unknown as DepartmentRepository,
    {
      findAll: vi.fn().mockResolvedValue([{
        id: 'employee-001',
        employeeNo: 'GQ001',
        displayName: '测试员工',
        status: 'active',
        departmentIds: ['department-001'],
        primaryDepartmentId: 'department-001',
        positionIds: [],
        jobLevelId: null,
        version: 2,
      }]),
    } as unknown as EmployeeRepository,
    {
      findAll: vi.fn().mockResolvedValue([{
        id: 'employment-001',
        personId: 'person-001',
        employeeId: 'employee-001',
        status: 'active',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        version: 1,
      }]),
    } as unknown as EmploymentRepository,
  );

describe('算薪组织主数据快照', () => {
  it('只返回脱敏组织字段和 GaoQ employeeId', async () => {
    const page = await createService().page();
    expect(page.contractVersion).toBe('0.1.0');
    expect(page.employees[0]?.employeeId).toBe('employee-001');
    expect(JSON.stringify(page)).not.toMatch(/bank|idCard|taxId|mobile/i);
    expect(page.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('拒绝普通用户调用服务同步接口', async () => {
    await expect(createService('user').page()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
