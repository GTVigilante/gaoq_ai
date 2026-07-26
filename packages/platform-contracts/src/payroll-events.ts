import type { CloudEvent, Money } from '@gaoq/shared-types';

/** 平台契约版本。 */
export const PLATFORM_CONTRACT_VERSION = '0.1.0' as const;

/** ERP 发往算薪系统的组织主数据事件类型。 */
export const ERP_PAYROLL_MASTER_DATA_EVENT_TYPES = [
  'com.gaoq.erp.org.department.upserted.v1',
  'com.gaoq.erp.org.employee.upserted.v1',
  'com.gaoq.erp.org.employment.changed.v1',
] as const;

/** 算薪系统发往 ERP 的脱敏控制面事件类型。 */
export const PAYROLL_ERP_SUMMARY_EVENT_TYPES = [
  'com.gaoq.payroll.run.status-changed.v1',
  'com.gaoq.payroll.payslip.published.v1',
  'com.gaoq.payroll.cost-summary.published.v1',
  'com.gaoq.payroll.reconciliation.completed.v1',
] as const;

export type ErpPayrollMasterDataEventType =
  (typeof ERP_PAYROLL_MASTER_DATA_EVENT_TYPES)[number];
export type PayrollErpSummaryEventType =
  (typeof PAYROLL_ERP_SUMMARY_EVENT_TYPES)[number];

/** 部门投影负载，只包含组织视图字段。 */
export interface DepartmentProjection {
  readonly departmentId: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly parentId: string | null;
  readonly managerEmployeeId: string | null;
  readonly sortOrder: number;
  readonly aggregateVersion: number;
}

/** 员工投影负载，以 GaoQ employeeId 作为唯一跨系统人员标识。 */
export interface EmployeeProjection {
  readonly employeeId: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
  readonly aggregateVersion: number;
}

/** 劳动关系投影负载。 */
export interface EmploymentProjection {
  readonly employmentId: string;
  readonly personId: string;
  readonly employeeId: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'resigned';
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly aggregateVersion: number;
}

/** 工资运行状态，只允许发布脱敏控制量。 */
export interface PayrollRunStatusSummary {
  readonly payrollRunId: string;
  readonly period: string;
  readonly status:
    | 'draft'
    | 'calculating'
    | 'calculated'
    | 'pending_approval'
    | 'locked'
    | 'reconciling'
    | 'reconciled'
    | 'failed';
  readonly employeeCount: number;
  readonly resultDigest: string | null;
  readonly version: number;
}

/** 工资条发布摘要，不包含个人工资条或员工标识。 */
export interface PayslipPublishedSummary {
  readonly payrollRunId: string;
  readonly period: string;
  readonly publishedCount: number;
  readonly publishedAt: string;
  readonly version: number;
}

/** 人力成本聚合摘要，不允许包含逐员工明细。 */
export interface PayrollCostSummary {
  readonly payrollRunId: string;
  readonly period: string;
  readonly employeeCount: number;
  readonly totalGross: Money;
  readonly totalEmployerCost: Money;
  readonly summaryDigest: string;
  readonly version: number;
}

/** 四方对账结果摘要。 */
export interface PayrollReconciliationSummary {
  readonly payrollRunId: string;
  readonly period: string;
  readonly status: 'reconciled' | 'frozen';
  readonly differenceCount: number;
  readonly evidenceDigest: string;
  readonly version: number;
}

type TypedCloudEvent<TType extends string, TData> =
  Omit<CloudEvent<TData>, 'type' | 'data'> & {
    readonly type: TType;
    readonly data: TData;
  };

export type DepartmentUpsertedEvent = TypedCloudEvent<
  'com.gaoq.erp.org.department.upserted.v1',
  DepartmentProjection
> & {
  readonly type: 'com.gaoq.erp.org.department.upserted.v1';
};
export type EmployeeUpsertedEvent = TypedCloudEvent<
  'com.gaoq.erp.org.employee.upserted.v1',
  EmployeeProjection
> & {
  readonly type: 'com.gaoq.erp.org.employee.upserted.v1';
};
export type EmploymentChangedEvent = TypedCloudEvent<
  'com.gaoq.erp.org.employment.changed.v1',
  EmploymentProjection
> & {
  readonly type: 'com.gaoq.erp.org.employment.changed.v1';
};
export type PayrollRunStatusChangedEvent = TypedCloudEvent<
  'com.gaoq.payroll.run.status-changed.v1',
  PayrollRunStatusSummary
> & {
  readonly type: 'com.gaoq.payroll.run.status-changed.v1';
};
export type PayslipPublishedEvent = TypedCloudEvent<
  'com.gaoq.payroll.payslip.published.v1',
  PayslipPublishedSummary
> & {
  readonly type: 'com.gaoq.payroll.payslip.published.v1';
};
export type PayrollCostSummaryPublishedEvent = TypedCloudEvent<
  'com.gaoq.payroll.cost-summary.published.v1',
  PayrollCostSummary
> & {
  readonly type: 'com.gaoq.payroll.cost-summary.published.v1';
};
export type PayrollReconciliationCompletedEvent = TypedCloudEvent<
  'com.gaoq.payroll.reconciliation.completed.v1',
  PayrollReconciliationSummary
> & {
  readonly type: 'com.gaoq.payroll.reconciliation.completed.v1';
};

export type ErpToPayrollEvent =
  | DepartmentUpsertedEvent
  | EmployeeUpsertedEvent
  | EmploymentChangedEvent;
export type PayrollToErpEvent =
  | PayrollRunStatusChangedEvent
  | PayslipPublishedEvent
  | PayrollCostSummaryPublishedEvent
  | PayrollReconciliationCompletedEvent;

const FORBIDDEN_SUMMARY_KEY =
  /employeeId|employeeNo|displayName|bank|account|card|idCard|taxId|payslip|salaryDetail|items/i;
const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/;

/** 校验跨系统金额必须使用整数分字符串。 */
export const isMoney = (value: unknown): value is Money => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.currency === 'CNY' &&
    typeof candidate.amountMinor === 'string' &&
    INTEGER_PATTERN.test(candidate.amountMinor);
};

/** 递归拒绝工资摘要事件中的个人或高敏字段。 */
export const containsForbiddenPayrollSummaryField = (
  value: unknown,
  depth = 0,
): boolean => {
  if (depth > 6) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenPayrollSummaryField(item, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      FORBIDDEN_SUMMARY_KEY.test(key) ||
      containsForbiddenPayrollSummaryField(nested, depth + 1),
  );
};

/** 校验算薪到 ERP 的事件只携带脱敏、租户化、可幂等控制面数据。 */
export const isSafePayrollToErpEvent = (value: unknown): value is PayrollToErpEvent => {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (
    event.specversion !== '1.0' ||
    typeof event.id !== 'string' ||
    typeof event.tenantId !== 'string' ||
    event.tenantId.length === 0 ||
    typeof event.traceId !== 'string' ||
    event.traceId.length === 0 ||
    typeof event.idempotencyKey !== 'string' ||
    event.idempotencyKey.length === 0 ||
    !PAYROLL_ERP_SUMMARY_EVENT_TYPES.includes(
      event.type as PayrollErpSummaryEventType,
    ) ||
    event.data === null ||
    typeof event.data !== 'object' ||
    containsForbiddenPayrollSummaryField(event.data)
  ) {
    return false;
  }
  if (event.type === 'com.gaoq.payroll.cost-summary.published.v1') {
    const data = event.data as Record<string, unknown>;
    return isMoney(data.totalGross) && isMoney(data.totalEmployerCost);
  }
  return true;
};

const isEventEnvelope = (event: Record<string, unknown>): boolean =>
  event.specversion === '1.0' &&
  typeof event.id === 'string' &&
  event.id.length > 0 &&
  typeof event.tenantId === 'string' &&
  event.tenantId.length > 0 &&
  typeof event.traceId === 'string' &&
  event.traceId.length > 0 &&
  typeof event.idempotencyKey === 'string' &&
  event.idempotencyKey.length > 0 &&
  event.data !== null &&
  typeof event.data === 'object';

/** 校验 ERP 到算薪系统的组织主数据事件信封与必要主键。 */
export const isErpToPayrollEvent = (value: unknown): value is ErpToPayrollEvent => {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (
    !isEventEnvelope(event) ||
    !ERP_PAYROLL_MASTER_DATA_EVENT_TYPES.includes(
      event.type as ErpPayrollMasterDataEventType,
    )
  ) return false;
  const data = event.data as Record<string, unknown>;
  if (event.type === 'com.gaoq.erp.org.department.upserted.v1') {
    return typeof data.departmentId === 'string' &&
      typeof data.aggregateVersion === 'number' &&
      Number.isInteger(data.aggregateVersion);
  }
  if (event.type === 'com.gaoq.erp.org.employee.upserted.v1') {
    return typeof data.employeeId === 'string' &&
      typeof data.aggregateVersion === 'number' &&
      Number.isInteger(data.aggregateVersion);
  }
  return typeof data.employmentId === 'string' &&
    typeof data.employeeId === 'string' &&
    typeof data.aggregateVersion === 'number' &&
    Number.isInteger(data.aggregateVersion);
};
