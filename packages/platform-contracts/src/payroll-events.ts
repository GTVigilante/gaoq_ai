import type { CloudEvent, Money } from '@gaoq/shared-types';

/** 平台契约版本。 */
export const PLATFORM_CONTRACT_VERSION = '1.0.0' as const;

/** ERP 发往算薪系统的组织主数据事件类型。 */
export const ERP_PAYROLL_MASTER_DATA_EVENT_TYPES = [
  'cn.gaoq.erp.department.upserted.v1',
  'cn.gaoq.erp.employee.upserted.v1',
  'cn.gaoq.erp.employment.changed.v1',
] as const;

/** 算薪系统发往 ERP 的脱敏控制面事件类型。 */
export const PAYROLL_ERP_SUMMARY_EVENT_TYPES = [
  'cn.gaoq.payroll.run.status_changed.v1',
  'cn.gaoq.payroll.payslip.published.v1',
  'cn.gaoq.payroll.cost_summary.published.v1',
  'cn.gaoq.payroll.reconciliation.completed.v1',
] as const;

/** 仅在一个迭代兼容窗口内允许迁移的旧事件类型。 */
export const LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS = Object.freeze({
  'com.gaoq.erp.org.department.upserted.v1':
    'cn.gaoq.erp.department.upserted.v1',
  'com.gaoq.erp.org.employee.upserted.v1':
    'cn.gaoq.erp.employee.upserted.v1',
  'com.gaoq.erp.org.employment.changed.v1':
    'cn.gaoq.erp.employment.changed.v1',
  'com.gaoq.payroll.run.status-changed.v1':
    'cn.gaoq.payroll.run.status_changed.v1',
  'com.gaoq.payroll.payslip.published.v1':
    'cn.gaoq.payroll.payslip.published.v1',
  'com.gaoq.payroll.cost-summary.published.v1':
    'cn.gaoq.payroll.cost_summary.published.v1',
  'com.gaoq.payroll.reconciliation.completed.v1':
    'cn.gaoq.payroll.reconciliation.completed.v1',
});

export type ErpPayrollMasterDataEventType =
  (typeof ERP_PAYROLL_MASTER_DATA_EVENT_TYPES)[number];
export type PayrollErpSummaryEventType =
  (typeof PAYROLL_ERP_SUMMARY_EVENT_TYPES)[number];
export type PayrollContractEventType =
  | ErpPayrollMasterDataEventType
  | PayrollErpSummaryEventType;

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
  Omit<
    CloudEvent<TData>,
    'type' | 'data' | 'time' | 'datacontenttype' | 'subject'
  > & {
    readonly type: TType;
    readonly subject: string;
    readonly time: string;
    readonly datacontenttype: 'application/json';
    readonly schemaVersion: '1';
    readonly data: TData;
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
export type PayrollContractEvent = ErpToPayrollEvent | PayrollToErpEvent;

const FORBIDDEN_SUMMARY_KEY =
  /employeeId|employeeNo|displayName|bank|account|card|idCard|taxId|payslip|salaryDetail|items/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MONEY_PATTERN = /^-?(?:0|[1-9]\d{0,17})$/u;
const NON_NEGATIVE_MONEY_PATTERN = /^(?:0|[1-9]\d{0,17})$/u;
const MAX_COUNT = 1_000_000;
const ENVELOPE_KEYS = [
  'specversion',
  'id',
  'source',
  'type',
  'subject',
  'time',
  'datacontenttype',
  'tenantId',
  'traceId',
  'idempotencyKey',
  'schemaVersion',
  'data',
] as const;
const SOURCE_BY_TYPE: Readonly<Record<PayrollContractEventType, string>> =
  Object.freeze({
    'cn.gaoq.erp.department.upserted.v1': '//gaoq-erp/org',
    'cn.gaoq.erp.employee.upserted.v1': '//gaoq-erp/org',
    'cn.gaoq.erp.employment.changed.v1': '//gaoq-erp/org',
    'cn.gaoq.payroll.run.status_changed.v1': '//gaoq-payroll/run',
    'cn.gaoq.payroll.payslip.published.v1': '//gaoq-payroll/payslip',
    'cn.gaoq.payroll.cost_summary.published.v1':
      '//gaoq-payroll/cost-summary',
    'cn.gaoq.payroll.reconciliation.completed.v1':
      '//gaoq-payroll/reconciliation',
  });

/** 校验跨系统金额必须使用范围受限的整数分字符串。 */
export const isMoney = (value: unknown): value is Money => {
  if (!isRecord(value) || !hasExactKeys(value, ['amountMinor', 'currency'])) {
    return false;
  }
  return value.currency === 'CNY' &&
    typeof value.amountMinor === 'string' &&
    MONEY_PATTERN.test(value.amountMinor);
};

/** 递归拒绝工资摘要事件中的个人、高敏字段和超深对象。 */
export const containsForbiddenPayrollSummaryField = (
  value: unknown,
  depth = 0,
): boolean => {
  if (depth > 6) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(
      (item) => containsForbiddenPayrollSummaryField(item, depth + 1),
    );
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      FORBIDDEN_SUMMARY_KEY.test(key) ||
      containsForbiddenPayrollSummaryField(nested, depth + 1),
  );
};

/** 校验算薪到 ERP 的事件只携带严格、脱敏、可幂等控制面数据。 */
export const isSafePayrollToErpEvent = (
  value: unknown,
): value is PayrollToErpEvent => {
  if (!isRecord(value) || !isPayrollSummaryType(value.type)) return false;
  if (
    !isEventEnvelope(value, value.type) ||
    containsForbiddenPayrollSummaryField(value.data)
  ) {
    return false;
  }
  return isPayrollSummaryPayload(value.type, value.data) &&
    hasMatchingSubject(value);
};

/** 校验 ERP 到算薪系统的组织主数据事件信封和完整投影。 */
export const isErpToPayrollEvent = (
  value: unknown,
): value is ErpToPayrollEvent => {
  if (!isRecord(value) || !isErpMasterDataType(value.type)) return false;
  return isEventEnvelope(value, value.type) &&
    isErpMasterDataPayload(value.type, value.data) &&
    hasMatchingSubject(value);
};

/** 校验任一当前版本专业算薪共享事件。 */
export const isPayrollContractEvent = (
  value: unknown,
): value is PayrollContractEvent =>
  isErpToPayrollEvent(value) || isSafePayrollToErpEvent(value);

/**
 * 将旧 `com.gaoq.*` 事件名迁移为当前规范名。
 *
 * 兼容入口仍要求当前版本的严格信封和数据字段；只迁移事件名称，禁止借兼容窗口
 * 接受缺字段、未知字段或旧宽松负载。
 */
export const migrateLegacyPayrollEvent = (
  value: unknown,
): PayrollContractEvent | null => {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const migratedType = Object.prototype.hasOwnProperty.call(
    LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS,
    value.type,
  )
    ? LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS[
      value.type as keyof typeof LEGACY_PAYROLL_EVENT_TYPE_MIGRATIONS
    ]
    : undefined;
  if (migratedType === undefined) return null;
  const candidate = { ...value, type: migratedType };
  return isPayrollContractEvent(candidate) ? candidate : null;
};

const isEventEnvelope = (
  event: Readonly<Record<string, unknown>>,
  type: PayrollContractEventType,
): boolean => {
  if (
    !hasExactKeys(event, ENVELOPE_KEYS) ||
    event.specversion !== '1.0' ||
    event.type !== type ||
    event.source !== SOURCE_BY_TYPE[type] ||
    event.datacontenttype !== 'application/json' ||
    event.schemaVersion !== '1' ||
    !isIdentifier(event.id) ||
    !isIdentifier(event.tenantId) ||
    !isIdentifier(event.traceId) ||
    typeof event.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_PATTERN.test(event.idempotencyKey) ||
    !isInstant(event.time) ||
    typeof event.subject !== 'string' ||
    event.subject.length > 320 ||
    !isRecord(event.data)
  ) {
    return false;
  }
  return event.idempotencyKey.startsWith(`${event.tenantId}:`);
};

const isErpMasterDataPayload = (
  type: ErpPayrollMasterDataEventType,
  value: unknown,
): boolean => {
  if (!isRecord(value)) return false;
  if (type === 'cn.gaoq.erp.department.upserted.v1') {
    return hasExactKeys(value, [
      'departmentId',
      'code',
      'name',
      'status',
      'parentId',
      'managerEmployeeId',
      'sortOrder',
      'aggregateVersion',
    ]) &&
      isIdentifier(value.departmentId) &&
      typeof value.code === 'string' &&
      CODE_PATTERN.test(value.code) &&
      isText(value.name, 200) &&
      isOneOf(value.status, ['active', 'inactive']) &&
      isNullableIdentifier(value.parentId) &&
      isNullableIdentifier(value.managerEmployeeId) &&
      isBoundedInteger(value.sortOrder, -MAX_COUNT, MAX_COUNT) &&
      isVersion(value.aggregateVersion);
  }
  if (type === 'cn.gaoq.erp.employee.upserted.v1') {
    return hasExactKeys(value, [
      'employeeId',
      'employeeNo',
      'displayName',
      'status',
      'departmentIds',
      'primaryDepartmentId',
      'positionIds',
      'jobLevelId',
      'aggregateVersion',
    ]) &&
      isIdentifier(value.employeeId) &&
      typeof value.employeeNo === 'string' &&
      CODE_PATTERN.test(value.employeeNo) &&
      isText(value.displayName, 200) &&
      isOneOf(
        value.status,
        ['probation', 'active', 'suspended', 'terminated'],
      ) &&
      isIdentifierArray(value.departmentIds, false) &&
      isIdentifier(value.primaryDepartmentId) &&
      (value.departmentIds as readonly unknown[])
        .includes(value.primaryDepartmentId) &&
      isIdentifierArray(value.positionIds, true) &&
      isNullableIdentifier(value.jobLevelId) &&
      isVersion(value.aggregateVersion);
  }
  return hasExactKeys(value, [
    'employmentId',
    'personId',
    'employeeId',
    'status',
    'effectiveFrom',
    'effectiveTo',
    'aggregateVersion',
  ]) &&
    isIdentifier(value.employmentId) &&
    isIdentifier(value.personId) &&
    isIdentifier(value.employeeId) &&
    isOneOf(value.status, ['probation', 'active', 'suspended', 'resigned']) &&
    isDate(value.effectiveFrom) &&
    (value.effectiveTo === null || isDate(value.effectiveTo)) &&
    (
      value.effectiveTo === null ||
      String(value.effectiveTo) >= String(value.effectiveFrom)
    ) &&
    isVersion(value.aggregateVersion);
};

const isPayrollSummaryPayload = (
  type: PayrollErpSummaryEventType,
  value: unknown,
): boolean => {
  if (!isRecord(value)) return false;
  if (type === 'cn.gaoq.payroll.run.status_changed.v1') {
    return hasExactKeys(value, [
      'payrollRunId',
      'period',
      'status',
      'employeeCount',
      'resultDigest',
      'version',
    ]) &&
      isIdentifier(value.payrollRunId) &&
      isPeriod(value.period) &&
      isOneOf(value.status, [
        'draft',
        'calculating',
        'calculated',
        'pending_approval',
        'locked',
        'reconciling',
        'reconciled',
        'failed',
      ]) &&
      isCount(value.employeeCount) &&
      (value.resultDigest === null || isDigest(value.resultDigest)) &&
      isVersion(value.version);
  }
  if (type === 'cn.gaoq.payroll.payslip.published.v1') {
    return hasExactKeys(value, [
      'payrollRunId',
      'period',
      'publishedCount',
      'publishedAt',
      'version',
    ]) &&
      isIdentifier(value.payrollRunId) &&
      isPeriod(value.period) &&
      isCount(value.publishedCount) &&
      isInstant(value.publishedAt) &&
      isVersion(value.version);
  }
  if (type === 'cn.gaoq.payroll.cost_summary.published.v1') {
    return hasExactKeys(value, [
      'payrollRunId',
      'period',
      'employeeCount',
      'totalGross',
      'totalEmployerCost',
      'summaryDigest',
      'version',
    ]) &&
      isIdentifier(value.payrollRunId) &&
      isPeriod(value.period) &&
      isCount(value.employeeCount) &&
      isNonNegativeMoney(value.totalGross) &&
      isNonNegativeMoney(value.totalEmployerCost) &&
      isDigest(value.summaryDigest) &&
      isVersion(value.version);
  }
  return hasExactKeys(value, [
    'payrollRunId',
    'period',
    'status',
    'differenceCount',
    'evidenceDigest',
    'version',
  ]) &&
    isIdentifier(value.payrollRunId) &&
    isPeriod(value.period) &&
    isOneOf(value.status, ['reconciled', 'frozen']) &&
    isCount(value.differenceCount) &&
    isDigest(value.evidenceDigest) &&
    isVersion(value.version) &&
    (value.status !== 'reconciled' || value.differenceCount === 0);
};

const hasMatchingSubject = (
  event: Readonly<Record<string, unknown>>,
): boolean => {
  if (!isRecord(event.data) || typeof event.tenantId !== 'string') return false;
  const type = event.type as PayrollContractEventType;
  const mapping: Readonly<
    Record<PayrollContractEventType, readonly [string, string]>
  > = {
    'cn.gaoq.erp.department.upserted.v1':
      ['department', 'departmentId'],
    'cn.gaoq.erp.employee.upserted.v1': ['employee', 'employeeId'],
    'cn.gaoq.erp.employment.changed.v1': ['employment', 'employmentId'],
    'cn.gaoq.payroll.run.status_changed.v1': ['payroll_run', 'payrollRunId'],
    'cn.gaoq.payroll.payslip.published.v1': ['payroll_run', 'payrollRunId'],
    'cn.gaoq.payroll.cost_summary.published.v1':
      ['payroll_run', 'payrollRunId'],
    'cn.gaoq.payroll.reconciliation.completed.v1':
      ['payroll_run', 'payrollRunId'],
  };
  const [entity, key] = mapping[type];
  return event.subject ===
    `tenant/${event.tenantId}/${entity}/${String(event.data[key])}`;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER_PATTERN.test(value);

const isNullableIdentifier = (value: unknown): boolean =>
  value === null || isIdentifier(value);

const isIdentifierArray = (
  value: unknown,
  allowEmpty: boolean,
): value is readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => !isIdentifier(item))
  ) {
    return false;
  }
  return new Set(value).size === value.length;
};

const isText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= maxLength &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const isBoundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;

const isVersion = (value: unknown): value is number =>
  isBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);

const isCount = (value: unknown): value is number =>
  isBoundedInteger(value, 0, MAX_COUNT);

const isOneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T =>
  typeof value === 'string' && allowed.includes(value as T);

const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
};

const isPeriod = (value: unknown): value is string =>
  typeof value === 'string' && PERIOD_PATTERN.test(value);

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  INSTANT_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(value));

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

const isNonNegativeMoney = (value: unknown): value is Money =>
  isMoney(value) &&
  NON_NEGATIVE_MONEY_PATTERN.test(value.amountMinor);

const isErpMasterDataType = (
  value: unknown,
): value is ErpPayrollMasterDataEventType =>
  typeof value === 'string' &&
  ERP_PAYROLL_MASTER_DATA_EVENT_TYPES.includes(
    value as ErpPayrollMasterDataEventType,
  );

const isPayrollSummaryType = (
  value: unknown,
): value is PayrollErpSummaryEventType =>
  typeof value === 'string' &&
  PAYROLL_ERP_SUMMARY_EVENT_TYPES.includes(
    value as PayrollErpSummaryEventType,
  );
