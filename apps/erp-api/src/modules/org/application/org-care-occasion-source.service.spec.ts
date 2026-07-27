import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OrgCareOccasionSourceService } from './org-care-occasion-source.service.js';

describe('OrgCareOccasionSourceService', () => {
  it('只从有效 Employee、当前 Employment、Person 证明和复聘历史形成窄投影', async () => {
    const context = new TenantContextService();
    const employee = {
      id: 'employee-001',
      status: 'active',
      departmentIds: ['department-001'],
    };
    const current = {
      id: 'employment-002',
      employeeId: employee.id,
      personId: 'person-001',
      status: 'active',
      effectiveFrom: '2025-03-01',
      effectiveTo: null,
    };
    const service = new OrgCareOccasionSourceService(
      context,
      { findById: vi.fn().mockResolvedValue(employee) } as never,
      {
        findOpenByEmployeeId: vi.fn().mockResolvedValue(current),
        findByPersonId: vi.fn().mockResolvedValue([
          current,
          { ...current, id: 'employment-001', effectiveFrom: '2020-02-29' },
        ]),
      } as never,
      {
        findBirthdayProjectionById: vi.fn().mockResolvedValue({
          person: {
            id: 'person-001',
            status: 'active',
            birthdayEvidenceId: 'evidence-001',
          },
          birthdayBlindIndexes: ['key-001.fingerprint'],
        }),
      } as never,
      {
        resolveMonthDay: vi.fn().mockReturnValue('02-29'),
      } as never,
    );
    const result = await runSource(context, () =>
      service.getEligibleByEmployeeId('employee-001'),
    );
    expect(result).toMatchObject({
      personId: 'person-001',
      employeeId: 'employee-001',
      currentEmploymentId: 'employment-002',
      birthdayMonthDay: '02-29',
      currentEmploymentEffectiveFrom: '2025-03-01',
      employmentEffectiveFromDates: ['2020-02-29', '2025-03-01'],
    });
    expect(result?.birthdaySourceRevision).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('停职、离职或无当前劳动关系默认拒绝且不解析生日', async () => {
    const context = new TenantContextService();
    const resolveMonthDay = vi.fn();
    const service = new OrgCareOccasionSourceService(
      context,
      {
        findById: vi.fn().mockResolvedValue({
          id: 'employee-001',
          status: 'terminated',
          departmentIds: [],
        }),
      } as never,
      { findOpenByEmployeeId: vi.fn() } as never,
      { findBirthdayProjectionById: vi.fn() } as never,
      { resolveMonthDay } as never,
    );
    await expect(runSource(context, () =>
      service.getEligibleByEmployeeId('employee-001'),
    )).resolves.toBeNull();
    expect(resolveMonthDay).not.toHaveBeenCalled();
  });

  it('即使知道员工标识，缺少内部 source Scope 也不可读取', async () => {
    const context = new TenantContextService();
    const service = new OrgCareOccasionSourceService(
      context,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(context.run({
      tenant: { tenantId: 'tenant-001', source: 'access_token' },
      actor: {
        actorId: 'user-001',
        actorType: 'user',
        tenantId: 'tenant-001',
        roleCodes: ['EMPLOYEE'],
        scopes: [],
        departmentIds: [],
        traceId: 'trace-denied',
      },
    }, () => service.getEligibleByEmployeeId('employee-001'))).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_DENIED' },
    });
  });
});

function runSource<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorId: 'system:care-source',
      actorType: 'system_job',
      tenantId: 'tenant-001',
      roleCodes: ['CARE_OCCASION_SOURCE'],
      scopes: ['erp:care:occasion:source:read'],
      departmentIds: [],
      traceId: 'trace-source',
    },
  }, operation);
}
