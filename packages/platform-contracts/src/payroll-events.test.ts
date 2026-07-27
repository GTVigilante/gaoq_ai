import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  containsForbiddenPayrollSummaryField,
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES,
  isErpToPayrollEvent,
  isMoney,
  isPayrollContractEvent,
  isSafePayrollToErpEvent,
  LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS,
  migrateLegacyPayrollEvent,
  PAYROLL_ERP_SUMMARY_EVENT_TYPES,
  PAYROLL_EVENT_JSON_SCHEMAS,
  PLATFORM_CONTRACT_VERSION,
  type EmployeeProjection,
  type PayrollCostSummaryPublishedEvent,
} from './index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TENANT_ID = 'tenant-001';
const EVENT_BASE = Object.freeze({
  specversion: '1.0' as const,
  id: 'event-001',
  time: '2026-07-27T00:00:00.000Z',
  datacontenttype: 'application/json' as const,
  tenantId: TENANT_ID,
  traceId: 'trace-001',
  idempotencyKey: `${TENANT_ID}:event-001:1`,
  schemaVersion: '1' as const,
});

const validCostEvent: PayrollCostSummaryPublishedEvent = {
  ...EVENT_BASE,
  source: '//gaoq-payroll/cost-summary',
  type: 'cn.gaoq.payroll.cost_summary.published.v1',
  subject: `tenant/${TENANT_ID}/payroll_run/payroll-run-001`,
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

const validEvents = Object.freeze([
  {
    ...EVENT_BASE,
    source: '//gaoq-erp/org',
    type: 'cn.gaoq.erp.department.upserted.v1',
    subject: `tenant/${TENANT_ID}/department/department-001`,
    data: {
      departmentId: 'department-001',
      code: 'OPS',
      name: '运营部',
      status: 'active',
      parentId: null,
      managerEmployeeId: 'employee-001',
      sortOrder: 10,
      aggregateVersion: 3,
    },
  },
  {
    ...EVENT_BASE,
    id: 'event-002',
    idempotencyKey: `${TENANT_ID}:event-002:1`,
    source: '//gaoq-erp/org',
    type: 'cn.gaoq.erp.employee.upserted.v1',
    subject: `tenant/${TENANT_ID}/employee/employee-001`,
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
  },
  {
    ...EVENT_BASE,
    id: 'event-003',
    idempotencyKey: `${TENANT_ID}:event-003:1`,
    source: '//gaoq-erp/org',
    type: 'cn.gaoq.erp.employment.changed.v1',
    subject: `tenant/${TENANT_ID}/employment/employment-001`,
    data: {
      employmentId: 'employment-001',
      personId: 'person-001',
      employeeId: 'employee-001',
      status: 'active',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      aggregateVersion: 2,
    },
  },
  {
    ...EVENT_BASE,
    id: 'event-004',
    idempotencyKey: `${TENANT_ID}:event-004:1`,
    source: '//gaoq-payroll/run',
    type: 'cn.gaoq.payroll.run.status_changed.v1',
    subject: `tenant/${TENANT_ID}/payroll_run/payroll-run-001`,
    data: {
      payrollRunId: 'payroll-run-001',
      period: '2026-07',
      status: 'locked',
      employeeCount: 300,
      resultDigest: DIGEST,
      version: 4,
    },
  },
  {
    ...EVENT_BASE,
    id: 'event-005',
    idempotencyKey: `${TENANT_ID}:event-005:1`,
    source: '//gaoq-payroll/payslip',
    type: 'cn.gaoq.payroll.payslip.published.v1',
    subject: `tenant/${TENANT_ID}/payroll_run/payroll-run-001`,
    data: {
      payrollRunId: 'payroll-run-001',
      period: '2026-07',
      publishedCount: 300,
      publishedAt: '2026-07-27T00:00:00.000Z',
      version: 5,
    },
  },
  validCostEvent,
  {
    ...EVENT_BASE,
    id: 'event-007',
    idempotencyKey: `${TENANT_ID}:event-007:1`,
    source: '//gaoq-payroll/reconciliation',
    type: 'cn.gaoq.payroll.reconciliation.completed.v1',
    subject: `tenant/${TENANT_ID}/payroll_run/payroll-run-001`,
    data: {
      payrollRunId: 'payroll-run-001',
      period: '2026-07',
      status: 'reconciled',
      differenceCount: 0,
      evidenceDigest: DIGEST,
      version: 6,
    },
  },
]);

describe('工资平台共享契约', () => {
  it('将规范名称、包版本和机器可读 Schema 逐类型锁定', () => {
    expect(PLATFORM_CONTRACT_VERSION).toBe('1.0.0');
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
    expect(Object.keys(PAYROLL_EVENT_JSON_SCHEMAS).sort()).toEqual(
      [...ERP_PAYROLL_MASTER_DATA_EVENT_TYPES, ...PAYROLL_ERP_SUMMARY_EVENT_TYPES]
        .sort(),
    );
    for (const schema of Object.values(PAYROLL_EVENT_JSON_SCHEMAS)) {
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, unknown>;
      expect(
        (properties.data as Record<string, unknown>).additionalProperties,
      ).toBe(false);
    }
  });

  it('使用 GaoQ employeeId 作为跨系统员工主键', () => {
    expectTypeOf<EmployeeProjection['employeeId']>().toEqualTypeOf<string>();
    expect(isErpToPayrollEvent(validEvents[1])).toBe(true);
  });

  it('逐类型接受完整的 ERP 主数据和算薪控制面事件', () => {
    expect(validEvents.every((event) => isPayrollContractEvent(event))).toBe(true);
    expect(validEvents.slice(0, 3).every(isErpToPayrollEvent)).toBe(true);
    expect(validEvents.slice(3).every(isSafePayrollToErpEvent)).toBe(true);
  });

  it('拒绝未知字段、空数据、数组注入和超深对象', () => {
    expect(isPayrollContractEvent({
      ...validCostEvent,
      unexpected: true,
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, unexpected: true },
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      data: {},
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      data: [],
    })).toBe(false);
    expect(containsForbiddenPayrollSummaryField({
      a: { b: { c: { d: { e: { f: { g: { h: true } } } } } } },
    })).toBe(true);
  });

  it('严格校验信封来源、主题、时间、版本、长度和幂等租户', () => {
    expect(isPayrollContractEvent({
      ...validCostEvent,
      source: '//untrusted/payroll',
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      subject: `tenant/${TENANT_ID}/payroll_run/other`,
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      time: '2026-07-27',
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      schemaVersion: '2',
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      id: `event-${'x'.repeat(128)}`,
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...validCostEvent,
      idempotencyKey: 'other-tenant:event-001:1',
    })).toBe(false);
    let deep: Record<string, unknown> = { value: 'safe' };
    for (let index = 0; index < 8; index += 1) deep = { nested: deep };
    expect(containsForbiddenPayrollSummaryField(deep)).toBe(true);
  });

  it('拒绝错误状态、期间、日期、负计数和不一致终态', () => {
    const statusEvent = validEvents[3]!;
    expect(isPayrollContractEvent({
      ...statusEvent,
      data: { ...statusEvent.data, status: 'paid' },
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...statusEvent,
      data: { ...statusEvent.data, period: '2026-13' },
    })).toBe(false);
    expect(isPayrollContractEvent({
      ...statusEvent,
      data: { ...statusEvent.data, employeeCount: -1 },
    })).toBe(false);
    const employmentEvent = validEvents[2]!;
    expect(isPayrollContractEvent({
      ...employmentEvent,
      data: {
        ...employmentEvent.data,
        effectiveFrom: '2026-02-30',
      },
    })).toBe(false);
    const reconciliationEvent = validEvents[6]!;
    expect(isPayrollContractEvent({
      ...reconciliationEvent,
      data: { ...reconciliationEvent.data, differenceCount: 1 },
    })).toBe(false);
  });

  it('金额为受限整数分，成本摘要禁止负数和错误摘要格式', () => {
    expect(isMoney({ amountMinor: '12345', currency: 'CNY' })).toBe(true);
    expect(isMoney({ amountMinor: '-12345', currency: 'CNY' })).toBe(true);
    expect(isMoney({ amountMinor: '123.45', currency: 'CNY' })).toBe(false);
    expect(isMoney({ amountMinor: '1'.repeat(19), currency: 'CNY' })).toBe(false);
    expect(isMoney({
      amountMinor: '1',
      currency: 'CNY',
      unexpected: true,
    })).toBe(false);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: {
        ...validCostEvent.data,
        totalGross: { amountMinor: '-1', currency: 'CNY' },
      },
    })).toBe(false);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: { ...validCostEvent.data, summaryDigest: 'sha256-summary' },
    })).toBe(false);
  });

  it('递归拒绝工资摘要中的个人或高敏字段', () => {
    expect(containsForbiddenPayrollSummaryField({
      employeeId: 'employee-001',
    })).toBe(true);
    expect(containsForbiddenPayrollSummaryField({
      nested: { bankAccount: 'secret' },
    })).toBe(true);
    expect(isSafePayrollToErpEvent({
      ...validCostEvent,
      data: {
        ...validCostEvent.data,
        salaryDetails: [{ amountMinor: '1' }],
      },
    })).toBe(false);
  });

  it('旧事件名只通过显式迁移入口兼容一个迭代', () => {
    const legacyType = 'com.gaoq.payroll.cost-summary.published.v1' as const;
    const legacy = {
      ...validCostEvent,
      type: legacyType,
    };
    expect(isPayrollContractEvent(legacy)).toBe(false);
    expect(
      LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS[legacyType],
    ).toBe('cn.gaoq.payroll.cost_summary.published.v1');
    expect(migrateLegacyPayrollEvent(legacy)?.type)
      .toBe('cn.gaoq.payroll.cost_summary.published.v1');
    expect(migrateLegacyPayrollEvent({
      ...legacy,
      data: {},
    })).toBeNull();
  });
});
