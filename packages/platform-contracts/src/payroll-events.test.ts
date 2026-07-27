import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  containsForbiddenPayrollSummaryField,
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES,
  isErpToPayrollEvent,
  isMoney,
  isSafePayrollToErpEvent,
  PAYROLL_ERP_SUMMARY_EVENT_TYPES,
  PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA,
  PLATFORM_CONTRACT_VERSION,
  type EmployeeProjection,
  type PayrollCostSummaryPublishedEvent,
} from './index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const validCostEvent: PayrollCostSummaryPublishedEvent = {
  ...envelope('payroll/cost_summary/payroll-run-001'),
  type: 'cn.gaoq.payroll.cost_summary.published.v1',
  data: {
    payrollRunId: 'payroll-run-001',
    period: '2026-07',
    employeeCount: 300,
    totalGross: { amountMinor: '600000000', currency: 'CNY' },
    totalEmployerCost: { amountMinor: '720000000', currency: 'CNY' },
    summaryDigest: DIGEST,
    version: 2,
  },
};

describe('工资平台共享契约', () => {
  it('使用规范事件名并在首次外部发布前拒绝旧 com.gaoq 命名', () => {
    expect(PLATFORM_CONTRACT_VERSION).toBe('0.2.0');
    expect(ERP_PAYROLL_MASTER_DATA_EVENT_TYPES).toEqual([
      'cn.gaoq.erp.department.upserted.v1',
      'cn.gaoq.erp.employee.upserted.v1',
      'cn.gaoq.erp.employment.changed.v1',
    ]);
    expect(PAYROLL_ERP_SUMMARY_EVENT_TYPES).toEqual([
      'cn.gaoq.payroll.run.status_changed.v1',
      'cn.gaoq.payroll.payslip.published.v1',
      'cn.gaoq.payroll.cost_summary.published.v1',
      'cn.gaoq.payroll.reconciliation.completed.v1',
    ]);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      type: 'com.gaoq.payroll.cost-summary.published.v1',
    })).toBe(false);
  });

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

  it('严格验证 ERP 员工投影、状态、数组、主部门和未知字段', () => {
    const valid = {
      ...envelope('erp/employee/employee-001'),
      type: 'cn.gaoq.erp.employee.upserted.v1',
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
    };
    expect(isErpToPayrollEvent(valid)).toBe(true);
    expect(isErpToPayrollEvent({
      ...valid,
      data: { ...valid.data, status: 'unknown' },
    })).toBe(false);
    expect(isErpToPayrollEvent({
      ...valid,
      data: { ...valid.data, departmentIds: ['department-002'] },
    })).toBe(false);
    expect(isErpToPayrollEvent({
      ...valid,
      data: { ...valid.data, tenantId: 'injected' },
    })).toBe(false);
    expect(isErpToPayrollEvent({
      ...valid,
      data: [],
    })).toBe(false);
  });

  it('CloudEvents 信封要求精确字段、UTC 时间、来源、主题与租户一致', () => {
    expect(isSafePayrollToErpEvent(validCostEvent)).toBe(true);
    for (const invalid of [
      { ...validCostEvent, tenantId: '' },
      { ...validCostEvent, idempotencyKey: '' },
      { ...validCostEvent, time: '2026-07-27' },
      { ...validCostEvent, source: 'https://user:secret@example.com/events' },
      { ...validCostEvent, subject: 'tenant/other/payroll/run-001' },
      { ...validCostEvent, schemaVersion: '2' },
      { ...validCostEvent, unknown: true },
    ]) {
      expect(isSafePayrollToErpEvent(invalid)).toBe(false);
    }
  });

  it('逐事件拒绝空数据、字段缺失、错误状态、负计数和错误摘要', () => {
    expect(isSafePayrollToErpEvent({ ...validCostEvent, data: {} })).toBe(false);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, employeeCount: -1 },
    })).toBe(false);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, summaryDigest: 'sha256-summary' },
    })).toBe(false);
    const run = {
      ...envelope('payroll/run/payroll-run-001'),
      type: 'cn.gaoq.payroll.run.status_changed.v1',
      data: {
        payrollRunId: 'payroll-run-001',
        period: '2026-07',
        status: 'locked',
        employeeCount: 300,
        resultDigest: null,
        version: 2,
      },
    };
    expect(isSafePayrollToErpEvent(run)).toBe(false);
  });

  it('跨系统金额只接受非负整数分字符串和 CNY', () => {
    expect(isMoney({ amountMinor: '12345', currency: 'CNY' })).toBe(true);
    expect(isMoney({ amountMinor: '-1', currency: 'CNY' })).toBe(false);
    expect(isMoney({ amountMinor: '123.45', currency: 'CNY' })).toBe(false);
    expect(isMoney({ amountMinor: 12345, currency: 'CNY' })).toBe(false);
    expect(isMoney({ amountMinor: '1', currency: 'USD' })).toBe(false);
  });

  it('递归拒绝个人工资、高敏字段和超深对象', () => {
    expect(containsForbiddenPayrollSummaryField({ employeeId: 'employee-001' })).toBe(true);
    expect(containsForbiddenPayrollSummaryField({ bankAccount: 'secret' })).toBe(true);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, salaryDetails: [{ amountMinor: '1' }] },
    })).toBe(false);
    let deep: Record<string, unknown> = { value: 'safe' };
    for (let index = 0; index < 8; index += 1) deep = { nested: deep };
    expect(containsForbiddenPayrollSummaryField(deep)).toBe(true);
  });

  it('导出可共享的严格 JSON Schema Draft-07', () => {
    expect(PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA.$schema)
      .toBe('http://json-schema.org/draft-07/schema#');
    expect(JSON.stringify(PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA))
      .toContain('cn.gaoq.payroll.cost_summary.published.v1');
    expect(JSON.stringify(PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA))
      .toContain('additionalProperties');
  });
});

function envelope(subjectSuffix: string) {
  return {
    specversion: '1.0' as const,
    id: 'event-001',
    source: '/payroll/events',
    time: '2026-07-27T00:00:00.000Z',
    datacontenttype: 'application/json' as const,
    tenantId: 'tenant-001',
    traceId: 'trace-001',
    idempotencyKey: `tenant-001:${subjectSuffix}:v1`,
    subject: `tenant/tenant-001/${subjectSuffix}`,
    schemaVersion: '1' as const,
  };
}
