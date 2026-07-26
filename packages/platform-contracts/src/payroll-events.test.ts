import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  containsForbiddenPayrollSummaryField,
  isErpToPayrollEvent,
  isMoney,
  isSafePayrollToErpEvent,
  type EmployeeProjection,
  type PayrollCostSummaryPublishedEvent,
} from './index.js';

const validCostEvent: PayrollCostSummaryPublishedEvent = {
  specversion: '1.0',
  id: 'event-001',
  source: '/payroll/runs',
  type: 'com.gaoq.payroll.cost-summary.published.v1',
  tenantId: 'tenant-001',
  traceId: 'trace-001',
  idempotencyKey: 'payroll-run-001:2:cost-summary',
  subject: 'payroll-run-001',
  data: {
    payrollRunId: 'payroll-run-001',
    period: '2026-07',
    employeeCount: 300,
    totalGross: { amountMinor: '600000000', currency: 'CNY' },
    totalEmployerCost: { amountMinor: '720000000', currency: 'CNY' },
    summaryDigest: 'sha256-summary',
    version: 2,
  },
};

describe('工资平台共享契约', () => {
  it('使用 GaoQ employeeId 作为跨系统员工主键', () => {
    expectTypeOf<EmployeeProjection['employeeId']>().toEqualTypeOf<string>();
    const projection: EmployeeProjection = {
      employeeId: 'employee-001',
      employeeNo: 'GQ001',
      displayName: '测试员工',
      status: 'active',
      departmentIds: ['department-001'],
      primaryDepartmentId: 'department-001',
      positionIds: [],
      jobLevelId: null,
      aggregateVersion: 3,
    };
    expect(projection.employeeId).toBe('employee-001');
  });

  it('验证 ERP 主数据事件的租户、幂等键与员工主键', () => {
    expect(isErpToPayrollEvent({
      specversion: '1.0',
      id: 'event-employee-001',
      source: '/erp/org/employees',
      type: 'com.gaoq.erp.org.employee.upserted.v1',
      tenantId: 'tenant-001',
      traceId: 'trace-001',
      idempotencyKey: 'employee-001:3',
      data: {
        employeeId: 'employee-001',
        employeeNo: 'GQ001',
        displayName: '测试员工',
        status: 'active',
        departmentIds: ['department-001'],
        primaryDepartmentId: 'department-001',
        positionIds: [],
        jobLevelId: null,
        aggregateVersion: 3,
      },
    })).toBe(true);
  });

  it('摘要事件必须带可信租户、追踪和幂等键', () => {
    expect(isSafePayrollToErpEvent(validCostEvent)).toBe(true);
    expect(isSafePayrollToErpEvent({ ...validCostEvent, tenantId: '' })).toBe(false);
    expect(isSafePayrollToErpEvent({ ...validCostEvent, idempotencyKey: '' })).toBe(false);
  });

  it('跨系统金额只接受整数分字符串', () => {
    expect(isMoney({ amountMinor: '12345', currency: 'CNY' })).toBe(true);
    expect(isMoney({ amountMinor: '123.45', currency: 'CNY' })).toBe(false);
    expect(isMoney({ amountMinor: 12345, currency: 'CNY' })).toBe(false);
  });

  it('拒绝工资摘要携带个人工资或高敏字段', () => {
    expect(containsForbiddenPayrollSummaryField({ employeeId: 'employee-001' })).toBe(true);
    expect(containsForbiddenPayrollSummaryField({ bankAccount: 'secret' })).toBe(true);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, salaryDetails: [{ amountMinor: '1' }] },
    })).toBe(false);
  });
});
