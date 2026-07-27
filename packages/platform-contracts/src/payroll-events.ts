import type { CloudEvent, Money } from '@gaoq/shared-types';
import { z } from 'zod';

/** 平台契约版本；0.2.0 在首次外部发布前纠正事件命名并收紧运行时 Schema。 */
export const PLATFORM_CONTRACT_VERSION = '0.2.0' as const;

/** ERP 发往专业算薪系统的组织主数据事件类型。 */
export const ERP_PAYROLL_MASTER_DATA_EVENT_TYPES = [
  'cn.gaoq.erp.department.upserted.v1',
  'cn.gaoq.erp.employee.upserted.v1',
  'cn.gaoq.erp.employment.changed.v1',
] as const;

/** 专业算薪系统发往 ERP 的脱敏控制面事件类型。 */
export const PAYROLL_ERP_SUMMARY_EVENT_TYPES = [
  'cn.gaoq.payroll.run.status_changed.v1',
  'cn.gaoq.payroll.payslip.published.v1',
  'cn.gaoq.payroll.cost_summary.published.v1',
  'cn.gaoq.payroll.reconciliation.completed.v1',
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
  Omit<CloudEvent<TData>, 'type' | 'data' | 'time' | 'datacontenttype' | 'subject'> & {
    readonly type: TType;
    readonly data: TData;
    readonly time: string;
    readonly datacontenttype: 'application/json';
    readonly subject: string;
    readonly schemaVersion: '1';
  };

export type DepartmentUpsertedEvent = TypedCloudEvent<
  'cn.gaoq.erp.department.upserted.v1',
  DepartmentProjection
>;
export type EmployeeUpsertedEvent = TypedCloudEvent<
  'cn.gaoq.erp.employee.upserted.v1',
  EmployeeProjection
>;
export type EmploymentChangedEvent = TypedCloudEvent<
  'cn.gaoq.erp.employment.changed.v1',
  EmploymentProjection
>;
export type PayrollRunStatusChangedEvent = TypedCloudEvent<
  'cn.gaoq.payroll.run.status_changed.v1',
  PayrollRunStatusSummary
>;
export type PayslipPublishedEvent = TypedCloudEvent<
  'cn.gaoq.payroll.payslip.published.v1',
  PayslipPublishedSummary
>;
export type PayrollCostSummaryPublishedEvent = TypedCloudEvent<
  'cn.gaoq.payroll.cost_summary.published.v1',
  PayrollCostSummary
>;
export type PayrollReconciliationCompletedEvent = TypedCloudEvent<
  'cn.gaoq.payroll.reconciliation.completed.v1',
  PayrollReconciliationSummary
>;

export type ErpToPayrollEvent =
  | DepartmentUpsertedEvent
  | EmployeeUpsertedEvent
  | EmploymentChangedEvent;
export type PayrollToErpEvent =
  | PayrollRunStatusChangedEvent
  | PayslipPublishedEvent
  | PayrollCostSummaryPublishedEvent
  | PayrollReconciliationCompletedEvent;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SOURCE = /^\/{1,2}[A-Za-z0-9][A-Za-z0-9._~:/-]{0,254}$/u;
const SUBJECT = /^tenant\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9._:/-]{1,255}$/u;
const UTC_DATETIME =
  /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/u;
const DATE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const PERIOD = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NON_NEGATIVE_MINOR = /^(?:0|[1-9]\d{0,29})$/u;
const FORBIDDEN_SUMMARY_KEY =
  /employeeId|employeeNo|displayName|bank|account|card|idCard|taxId|payslip|salaryDetail|items/iu;

const identifier = z.string().min(1).max(128).regex(IDENTIFIER);
const positiveVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeCount = z.number().int().min(0).max(10_000_000);
const date = z.string().regex(DATE).refine(isRealDate);
const utcDateTime = z.string().regex(UTC_DATETIME).refine(
  (value) => Number.isFinite(Date.parse(value)),
);
const digest = z.string().regex(DIGEST);
const moneySchema = z.strictObject({
  amountMinor: z.string().regex(NON_NEGATIVE_MINOR),
  currency: z.literal('CNY'),
});
const identifierArray = z.array(identifier).max(64).refine(
  (values) => new Set(values).size === values.length,
);

export const departmentProjectionSchema = z.strictObject({
  departmentId: identifier,
  code: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  name: z.string().trim().min(1).max(160),
  status: z.enum(['active', 'inactive']),
  parentId: identifier.nullable(),
  managerEmployeeId: identifier.nullable(),
  sortOrder: z.number().int().min(0).max(1_000_000),
  aggregateVersion: positiveVersion,
}).refine((value) => value.parentId !== value.departmentId, {
  message: 'parentId 禁止指向自身',
});

export const employeeProjectionSchema = z.strictObject({
  employeeId: identifier,
  employeeNo: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  displayName: z.string().trim().min(1).max(160),
  status: z.enum(['probation', 'active', 'suspended', 'terminated']),
  departmentIds: identifierArray.min(1),
  primaryDepartmentId: identifier,
  positionIds: identifierArray,
  jobLevelId: identifier.nullable(),
  aggregateVersion: positiveVersion,
}).refine((value) => value.departmentIds.includes(value.primaryDepartmentId), {
  message: 'primaryDepartmentId 必须包含在 departmentIds',
});

export const employmentProjectionSchema = z.strictObject({
  employmentId: identifier,
  personId: identifier,
  employeeId: identifier,
  status: z.enum(['probation', 'active', 'suspended', 'resigned']),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  aggregateVersion: positiveVersion,
}).refine(
  (value) => value.effectiveTo === null || value.effectiveTo >= value.effectiveFrom,
  { message: 'effectiveTo 不得早于 effectiveFrom' },
);

export const payrollRunStatusSummarySchema = z.strictObject({
  payrollRunId: identifier,
  period: z.string().regex(PERIOD),
  status: z.enum([
    'draft',
    'calculating',
    'calculated',
    'pending_approval',
    'locked',
    'reconciling',
    'reconciled',
    'failed',
  ]),
  employeeCount: nonNegativeCount,
  resultDigest: digest.nullable(),
  version: positiveVersion,
}).refine(
  (value) =>
    !['calculated', 'pending_approval', 'locked', 'reconciling', 'reconciled']
      .includes(value.status) ||
    value.resultDigest !== null,
  { message: '已计算及后续状态必须携带结果摘要' },
);

export const payslipPublishedSummarySchema = z.strictObject({
  payrollRunId: identifier,
  period: z.string().regex(PERIOD),
  publishedCount: nonNegativeCount,
  publishedAt: utcDateTime,
  version: positiveVersion,
});

export const payrollCostSummarySchema = z.strictObject({
  payrollRunId: identifier,
  period: z.string().regex(PERIOD),
  employeeCount: nonNegativeCount,
  totalGross: moneySchema,
  totalEmployerCost: moneySchema,
  summaryDigest: digest,
  version: positiveVersion,
});

export const payrollReconciliationSummarySchema = z.strictObject({
  payrollRunId: identifier,
  period: z.string().regex(PERIOD),
  status: z.enum(['reconciled', 'frozen']),
  differenceCount: nonNegativeCount,
  evidenceDigest: digest,
  version: positiveVersion,
}).refine(
  (value) => value.status !== 'reconciled' || value.differenceCount === 0,
  { message: 'reconciled 状态的差异计数必须为 0' },
);

const envelopeShape = {
  specversion: z.literal('1.0'),
  id: z.string().regex(EVENT_IDENTIFIER),
  source: z.string().regex(SOURCE),
  time: utcDateTime,
  datacontenttype: z.literal('application/json'),
  tenantId: identifier,
  traceId: z.string().min(8).max(128).regex(EVENT_IDENTIFIER),
  idempotencyKey: z.string().min(8).max(256).regex(/^[\x21-\x7E]+$/u),
  subject: z.string().regex(SUBJECT),
  schemaVersion: z.literal('1'),
} as const;

const eventSchema = <TType extends string, TData extends z.ZodType>(
  type: TType,
  data: TData,
) => z.strictObject({
  ...envelopeShape,
  type: z.literal(type),
  data,
}).refine(
  (value) => value.subject.startsWith(`tenant/${value.tenantId}/`),
  { message: 'subject 必须绑定同一 tenantId' },
);

export const departmentUpsertedEventSchema = eventSchema(
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES[0],
  departmentProjectionSchema,
);
export const employeeUpsertedEventSchema = eventSchema(
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES[1],
  employeeProjectionSchema,
);
export const employmentChangedEventSchema = eventSchema(
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES[2],
  employmentProjectionSchema,
);
export const payrollRunStatusChangedEventSchema = eventSchema(
  PAYROLL_ERP_SUMMARY_EVENT_TYPES[0],
  payrollRunStatusSummarySchema,
);
export const payslipPublishedEventSchema = eventSchema(
  PAYROLL_ERP_SUMMARY_EVENT_TYPES[1],
  payslipPublishedSummarySchema,
);
export const payrollCostSummaryPublishedEventSchema = eventSchema(
  PAYROLL_ERP_SUMMARY_EVENT_TYPES[2],
  payrollCostSummarySchema,
);
export const payrollReconciliationCompletedEventSchema = eventSchema(
  PAYROLL_ERP_SUMMARY_EVENT_TYPES[3],
  payrollReconciliationSummarySchema,
);

export const erpToPayrollEventSchema = z.union([
  departmentUpsertedEventSchema,
  employeeUpsertedEventSchema,
  employmentChangedEventSchema,
]);
export const payrollToErpEventSchema = z.union([
  payrollRunStatusChangedEventSchema,
  payslipPublishedEventSchema,
  payrollCostSummaryPublishedEventSchema,
  payrollReconciliationCompletedEventSchema,
]);
export const payrollPlatformEventSchema = z.union([
  erpToPayrollEventSchema,
  payrollToErpEventSchema,
]);

/** 可由应用、Worker、MCP 和外部算薪系统共同消费的 JSON Schema Draft-07。 */
export const PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA = Object.freeze(
  z.toJSONSchema(payrollPlatformEventSchema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  }),
);

/** 校验跨系统金额必须使用非负整数分字符串。 */
export const isMoney = (value: unknown): value is Money =>
  moneySchema.safeParse(value).success;

/** 递归拒绝工资摘要事件中的个人或高敏字段，并限制嵌套深度。 */
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

/** 严格校验专业算薪到 ERP 的脱敏控制面事件。 */
export const isSafePayrollToErpEvent = (value: unknown): value is PayrollToErpEvent =>
  !containsForbiddenPayrollSummaryField(dataOf(value)) &&
  payrollToErpEventSchema.safeParse(value).success;

/** 严格校验 ERP 到专业算薪系统的组织主数据事件。 */
export const isErpToPayrollEvent = (value: unknown): value is ErpToPayrollEvent =>
  erpToPayrollEventSchema.safeParse(value).success;

function dataOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return (value as Record<string, unknown>).data;
}

function isRealDate(value: string): boolean {
  const dateValue = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(dateValue.getTime()) && dateValue.toISOString().startsWith(value);
}
