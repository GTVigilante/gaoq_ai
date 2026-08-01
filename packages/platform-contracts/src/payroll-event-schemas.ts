/** 专业算薪共享事件 JSON Schema 的最小只读类型。 */
export type PayrollEventJsonSchema = Readonly<Record<string, unknown>>;

const IDENTIFIER_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
});
const TEXT_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 200,
});
const VERSION_SCHEMA = Object.freeze({
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const COUNT_SCHEMA = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: 1_000_000,
});
const DIGEST_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^sha256:[a-f0-9]{64}$',
});
const DATE_SCHEMA = Object.freeze({
  type: 'string',
  format: 'date',
});
const INSTANT_SCHEMA = Object.freeze({
  type: 'string',
  format: 'date-time',
  pattern: 'Z$',
});
const PERIOD_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
});
const MONEY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['amountMinor', 'currency'],
  properties: {
    amountMinor: {
      type: 'string',
      pattern: '^(0|[1-9]\\d{0,17})$',
    },
    currency: { const: 'CNY' },
  },
});
const IDENTIFIER_ARRAY_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: 100,
  uniqueItems: true,
  items: IDENTIFIER_SCHEMA,
});

const exactObject = (
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): PayrollEventJsonSchema => Object.freeze({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const DATA_SCHEMAS = Object.freeze({
  'cn.gaoq.erp.department.upserted.v1': exactObject(
    [
      'departmentId',
      'code',
      'name',
      'status',
      'parentId',
      'managerEmployeeId',
      'sortOrder',
      'aggregateVersion',
    ],
    {
      departmentId: IDENTIFIER_SCHEMA,
      code: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
      },
      name: TEXT_SCHEMA,
      status: { enum: ['active', 'inactive'] },
      parentId: { anyOf: [IDENTIFIER_SCHEMA, { type: 'null' }] },
      managerEmployeeId: { anyOf: [IDENTIFIER_SCHEMA, { type: 'null' }] },
      sortOrder: {
        type: 'integer',
        minimum: -1_000_000,
        maximum: 1_000_000,
      },
      aggregateVersion: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.erp.employee.upserted.v1': exactObject(
    [
      'employeeId',
      'employeeNo',
      'displayName',
      'status',
      'departmentIds',
      'primaryDepartmentId',
      'positionIds',
      'jobLevelId',
      'aggregateVersion',
    ],
    {
      employeeId: IDENTIFIER_SCHEMA,
      employeeNo: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
      },
      displayName: TEXT_SCHEMA,
      status: { enum: ['probation', 'active', 'suspended', 'terminated'] },
      departmentIds: {
        ...IDENTIFIER_ARRAY_SCHEMA,
        minItems: 1,
      },
      primaryDepartmentId: IDENTIFIER_SCHEMA,
      positionIds: IDENTIFIER_ARRAY_SCHEMA,
      jobLevelId: { anyOf: [IDENTIFIER_SCHEMA, { type: 'null' }] },
      aggregateVersion: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.erp.employment.changed.v1': exactObject(
    [
      'employmentId',
      'personId',
      'employeeId',
      'status',
      'effectiveFrom',
      'effectiveTo',
      'aggregateVersion',
    ],
    {
      employmentId: IDENTIFIER_SCHEMA,
      personId: IDENTIFIER_SCHEMA,
      employeeId: IDENTIFIER_SCHEMA,
      status: { enum: ['probation', 'active', 'suspended', 'resigned'] },
      effectiveFrom: DATE_SCHEMA,
      effectiveTo: { anyOf: [DATE_SCHEMA, { type: 'null' }] },
      aggregateVersion: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.payroll.run.status_changed.v1': exactObject(
    [
      'payrollRunId',
      'period',
      'status',
      'employeeCount',
      'resultDigest',
      'version',
    ],
    {
      payrollRunId: IDENTIFIER_SCHEMA,
      period: PERIOD_SCHEMA,
      status: {
        enum: [
          'draft',
          'calculating',
          'calculated',
          'pending_approval',
          'locked',
          'reconciling',
          'reconciled',
          'failed',
        ],
      },
      employeeCount: COUNT_SCHEMA,
      resultDigest: { anyOf: [DIGEST_SCHEMA, { type: 'null' }] },
      version: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.payroll.payslip.published.v1': exactObject(
    ['payrollRunId', 'period', 'publishedCount', 'publishedAt', 'version'],
    {
      payrollRunId: IDENTIFIER_SCHEMA,
      period: PERIOD_SCHEMA,
      publishedCount: COUNT_SCHEMA,
      publishedAt: INSTANT_SCHEMA,
      version: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.payroll.cost_summary.published.v1': exactObject(
    [
      'payrollRunId',
      'period',
      'employeeCount',
      'totalGross',
      'totalEmployerCost',
      'summaryDigest',
      'version',
    ],
    {
      payrollRunId: IDENTIFIER_SCHEMA,
      period: PERIOD_SCHEMA,
      employeeCount: COUNT_SCHEMA,
      totalGross: MONEY_SCHEMA,
      totalEmployerCost: MONEY_SCHEMA,
      summaryDigest: DIGEST_SCHEMA,
      version: VERSION_SCHEMA,
    },
  ),
  'cn.gaoq.payroll.reconciliation.completed.v1': exactObject(
    [
      'payrollRunId',
      'period',
      'status',
      'differenceCount',
      'evidenceDigest',
      'version',
    ],
    {
      payrollRunId: IDENTIFIER_SCHEMA,
      period: PERIOD_SCHEMA,
      status: { enum: ['reconciled', 'frozen'] },
      differenceCount: COUNT_SCHEMA,
      evidenceDigest: DIGEST_SCHEMA,
      version: VERSION_SCHEMA,
    },
  ),
});

const SOURCE_BY_TYPE = Object.freeze({
  'cn.gaoq.erp.department.upserted.v1': '//gaoq-erp/org',
  'cn.gaoq.erp.employee.upserted.v1': '//gaoq-erp/org',
  'cn.gaoq.erp.employment.changed.v1': '//gaoq-erp/org',
  'cn.gaoq.payroll.run.status_changed.v1': '//gaoq-payroll/run',
  'cn.gaoq.payroll.payslip.published.v1': '//gaoq-payroll/payslip',
  'cn.gaoq.payroll.cost_summary.published.v1': '//gaoq-payroll/cost-summary',
  'cn.gaoq.payroll.reconciliation.completed.v1': '//gaoq-payroll/reconciliation',
});

const envelopeSchema = (
  eventType: keyof typeof DATA_SCHEMAS,
): PayrollEventJsonSchema => exactObject(
  [
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
  ],
  {
    specversion: { const: '1.0' },
    id: IDENTIFIER_SCHEMA,
    source: { const: SOURCE_BY_TYPE[eventType] },
    type: { const: eventType },
    subject: {
      type: 'string',
      minLength: 1,
      maxLength: 320,
      pattern: '^tenant/[A-Za-z0-9][A-Za-z0-9._:-]*/[a-z_]+/[A-Za-z0-9][A-Za-z0-9._:-]*$',
    },
    time: INSTANT_SCHEMA,
    datacontenttype: { const: 'application/json' },
    tenantId: IDENTIFIER_SCHEMA,
    traceId: IDENTIFIER_SCHEMA,
    idempotencyKey: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
    },
    schemaVersion: { const: '1' },
    data: DATA_SCHEMAS[eventType],
  },
);

/** 各事件逐类型维护的 JSON Schema，应用、Worker 与外部算薪系统共用。 */
export const PAYROLL_EVENT_JSON_SCHEMAS: Readonly<
  Record<keyof typeof DATA_SCHEMAS, PayrollEventJsonSchema>
> = Object.freeze({
  'cn.gaoq.erp.department.upserted.v1':
    envelopeSchema('cn.gaoq.erp.department.upserted.v1'),
  'cn.gaoq.erp.employee.upserted.v1':
    envelopeSchema('cn.gaoq.erp.employee.upserted.v1'),
  'cn.gaoq.erp.employment.changed.v1':
    envelopeSchema('cn.gaoq.erp.employment.changed.v1'),
  'cn.gaoq.payroll.run.status_changed.v1':
    envelopeSchema('cn.gaoq.payroll.run.status_changed.v1'),
  'cn.gaoq.payroll.payslip.published.v1':
    envelopeSchema('cn.gaoq.payroll.payslip.published.v1'),
  'cn.gaoq.payroll.cost_summary.published.v1':
    envelopeSchema('cn.gaoq.payroll.cost_summary.published.v1'),
  'cn.gaoq.payroll.reconciliation.completed.v1':
    envelopeSchema('cn.gaoq.payroll.reconciliation.completed.v1'),
});
