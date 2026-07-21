export type PayrollPeriodStatus =
  | 'draft' | 'collecting' | 'review' | 'pending_approval' | 'approved'
  | 'locked' | 'disbursing' | 'reconciling' | 'reconciled';

export interface PayrollRunReference {
  readonly id: string;
  readonly inputSnapshotHash: string;
  readonly resultHash: string;
  readonly employeeCount: number;
  readonly totalGrossMinor: number;
  readonly totalTaxMinor: number;
  readonly totalNetMinor: number;
}

export interface PayrollPeriod {
  readonly id: string;
  readonly tenantId: string;
  readonly period: string;
  readonly currency: 'CNY';
  readonly status: PayrollPeriodStatus;
  readonly preparedBy: string;
  readonly activeRun: PayrollRunReference | null;
  readonly approvalInstanceId: string | null;
  readonly approvedBy: string | null;
  readonly approvalEvidenceId: string | null;
  readonly lockedBy: string | null;
  readonly strongAuthEvidenceId: string | null;
  readonly disbursementBatchId: string | null;
  readonly disbursementPreparedBy: string | null;
  readonly disbursementExportEvidenceId: string | null;
  readonly reconciliationEvidenceId: string | null;
  readonly reconciledBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class PayrollPeriodError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PayrollPeriodError';
  }
}

export function createPayrollPeriod(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly period: string;
  readonly preparedBy: string;
}, now: Date): PayrollPeriod {
  assertId(input.id, 'id');
  assertId(input.tenantId, 'tenantId');
  assertId(input.preparedBy, 'preparedBy');
  assertPeriod(input.period);
  const occurredAt = iso(now);
  return Object.freeze({
    ...input, currency: 'CNY', status: 'draft', activeRun: null,
    approvalInstanceId: null, approvedBy: null, approvalEvidenceId: null,
    lockedBy: null, strongAuthEvidenceId: null,
    disbursementBatchId: null, disbursementPreparedBy: null,
    disbursementExportEvidenceId: null,
    reconciliationEvidenceId: null, reconciledBy: null,
    version: 1, createdAt: occurredAt, updatedAt: occurredAt,
  });
}

export function startPayrollCollection(
  period: PayrollPeriod,
  command: BaseCommand,
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['draft']);
  return next(period, { status: 'collecting' }, now);
}

/** 新计算使旧审批失效；已批准或锁定周期禁止原地重算。 */
export function recordPayrollCalculation(
  period: PayrollPeriod,
  command: BaseCommand & { readonly run: PayrollRunReference },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['collecting', 'review']);
  validateRun(command.run);
  return next(period, {
    status: 'review', activeRun: frozenRun(command.run),
    approvalInstanceId: null, approvedBy: null, approvalEvidenceId: null,
  }, now);
}

export function submitPayrollApproval(
  period: PayrollPeriod,
  command: BaseCommand & { readonly approvalInstanceId: string },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['review']);
  if (period.activeRun === null) invalid('PAYROLL_RUN_REQUIRED', '提交审批前必须完成计算');
  assertId(command.approvalInstanceId, 'approvalInstanceId');
  return next(period, {
    status: 'pending_approval', approvalInstanceId: command.approvalInstanceId,
  }, now);
}

/** 只接受 Approval 可信终态；审批人与制单人必须分离。 */
export function applyPayrollApproval(
  period: PayrollPeriod,
  command: BaseCommand & {
    readonly approvalInstanceId: string;
    readonly outcome: 'approved' | 'rejected';
    readonly decidedBy: string;
    readonly approvalEvidenceId: string;
    readonly trustedApproval: boolean;
  },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['pending_approval']);
  for (const [field, value] of Object.entries({
    approvalInstanceId: command.approvalInstanceId,
    decidedBy: command.decidedBy,
    approvalEvidenceId: command.approvalEvidenceId,
  })) assertId(value, field);
  if (!command.trustedApproval || command.approvalInstanceId !== period.approvalInstanceId) {
    invalid('PAYROLL_APPROVAL_UNTRUSTED', '工资审批事实不可信或引用不匹配');
  }
  if (command.outcome === 'rejected') return next(period, {
    status: 'review', approvalInstanceId: null, approvedBy: null, approvalEvidenceId: null,
  }, now);
  if (command.decidedBy === period.preparedBy) {
    invalid('PAYROLL_DUAL_CONTROL_REQUIRED', '制单人与审批人必须分离');
  }
  return next(period, {
    status: 'approved', approvedBy: command.decidedBy,
    approvalEvidenceId: command.approvalEvidenceId,
  }, now);
}

/** 锁定属于 R3；锁定人不得是制单人或审批人，并必须引用近期强认证。 */
export function lockPayrollPeriod(
  period: PayrollPeriod,
  command: BaseCommand & { readonly lockedBy: string; readonly strongAuthEvidenceId: string },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['approved']);
  assertId(command.lockedBy, 'lockedBy');
  assertId(command.strongAuthEvidenceId, 'strongAuthEvidenceId');
  if (command.lockedBy === period.preparedBy || command.lockedBy === period.approvedBy) {
    invalid('PAYROLL_DUAL_CONTROL_REQUIRED', '锁定人必须独立于制单人与审批人');
  }
  return next(period, {
    status: 'locked', lockedBy: command.lockedBy,
    strongAuthEvidenceId: command.strongAuthEvidenceId,
  }, now);
}

export function startPayrollDisbursement(
  period: PayrollPeriod,
  command: BaseCommand & {
    readonly batchId: string;
    readonly preparedBy: string;
    readonly exportEvidenceId: string;
    readonly trustedExport: boolean;
  },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['locked']);
  assertId(command.batchId, 'batchId');
  assertId(command.preparedBy, 'preparedBy');
  assertId(command.exportEvidenceId, 'exportEvidenceId');
  if (!command.trustedExport) invalid('PAYROLL_DISBURSEMENT_UNTRUSTED', '代发导出事实不可信');
  if (command.preparedBy === period.lockedBy) {
    invalid('PAYROLL_DUAL_CONTROL_REQUIRED', '代发制备人与工资锁定人必须分离');
  }
  return next(period, {
    status: 'disbursing', disbursementBatchId: command.batchId,
    disbursementPreparedBy: command.preparedBy,
    disbursementExportEvidenceId: command.exportEvidenceId,
  }, now);
}

export function beginPayrollReconciliation(
  period: PayrollPeriod,
  command: BaseCommand & { readonly batchId: string },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['disbursing']);
  if (command.batchId !== period.disbursementBatchId) {
    invalid('PAYROLL_BATCH_REFERENCE_MISMATCH', '代发批次引用不匹配');
  }
  return next(period, { status: 'reconciling' }, now);
}

export function completePayrollReconciliation(
  period: PayrollPeriod,
  command: BaseCommand & {
    readonly reconciledBy: string;
    readonly reconciliationEvidenceId: string;
    readonly balanced: boolean;
    readonly trustedReconciliation: boolean;
  },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['reconciling']);
  assertId(command.reconciledBy, 'reconciledBy');
  assertId(command.reconciliationEvidenceId, 'reconciliationEvidenceId');
  if (!command.trustedReconciliation) {
    invalid('PAYROLL_RECONCILIATION_UNTRUSTED', '只接受受信任对账服务的结果');
  }
  if (!command.balanced) invalid('PAYROLL_RECONCILIATION_UNBALANCED', '四方对账未守恒');
  if (command.reconciledBy === period.disbursementPreparedBy) {
    invalid('PAYROLL_DUAL_CONTROL_REQUIRED', '对账人与代发制备人必须分离');
  }
  return next(period, {
    status: 'reconciled', reconciledBy: command.reconciledBy,
    reconciliationEvidenceId: command.reconciliationEvidenceId,
  }, now);
}

export function recordPayrollReconciliationMismatch(
  period: PayrollPeriod,
  command: BaseCommand & {
    readonly reconciliationEvidenceId: string;
    readonly trustedReconciliation: boolean;
  },
  now: Date,
): PayrollPeriod {
  assertCommand(period, command);
  requireStatus(period, ['reconciling']);
  assertId(command.reconciliationEvidenceId, 'reconciliationEvidenceId');
  if (!command.trustedReconciliation) {
    invalid('PAYROLL_RECONCILIATION_UNTRUSTED', '只接受受信任对账服务的结果');
  }
  return next(period, { reconciliationEvidenceId: command.reconciliationEvidenceId }, now);
}

interface BaseCommand {
  readonly tenantId: string;
  readonly expectedVersion: number;
}

function assertCommand(period: PayrollPeriod, command: BaseCommand): void {
  if (command.tenantId !== period.tenantId) invalid('PAYROLL_TENANT_MISMATCH', '工资周期租户不匹配');
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion !== period.version) {
    invalid('PAYROLL_VERSION_CONFLICT', '工资周期版本冲突');
  }
}

function requireStatus(period: PayrollPeriod, allowed: readonly PayrollPeriodStatus[]): void {
  if (!allowed.includes(period.status)) invalid('PAYROLL_PERIOD_TRANSITION_INVALID', '工资周期状态迁移无效');
}

function validateRun(run: PayrollRunReference): void {
  assertId(run.id, 'runId');
  if (!/^[A-Za-z0-9_-]{43}$/.test(run.inputSnapshotHash) || !/^[A-Za-z0-9_-]{43}$/.test(run.resultHash)) {
    invalid('PAYROLL_RUN_HASH_INVALID', '计算输入或结果摘要非法');
  }
  if (!Number.isSafeInteger(run.employeeCount) || run.employeeCount < 1) {
    invalid('PAYROLL_RUN_EMPLOYEE_COUNT_INVALID', '计算人数非法');
  }
  assertNonnegativeMinor(run.totalGrossMinor, 'totalGrossMinor');
  assertSignedMinor(run.totalTaxMinor, 'totalTaxMinor');
  assertNonnegativeMinor(run.totalNetMinor, 'totalNetMinor');
}

function frozenRun(run: PayrollRunReference): PayrollRunReference {
  return Object.freeze({ ...run });
}

function next(
  period: PayrollPeriod,
  changes: Partial<PayrollPeriod>,
  now: Date,
): PayrollPeriod {
  return Object.freeze({
    ...period, ...changes, id: period.id, tenantId: period.tenantId,
    period: period.period, currency: period.currency, preparedBy: period.preparedBy,
    version: period.version + 1, createdAt: period.createdAt, updatedAt: iso(now),
  });
}

function assertId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid('PAYROLL_IDENTIFIER_INVALID', `${field} 标识非法`);
  }
}

function assertPeriod(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) invalid('PAYROLL_PERIOD_INVALID', '工资期间非法');
}

function assertNonnegativeMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('PAYROLL_AMOUNT_INVALID', `${field} 必须为非负安全整数分`);
  }
}

function assertSignedMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) invalid('PAYROLL_AMOUNT_INVALID', `${field} 必须为安全整数分`);
}

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) invalid('PAYROLL_TIME_INVALID', '业务时间非法');
  return value.toISOString();
}

function invalid(code: string, message: string): never {
  throw new PayrollPeriodError(code, message);
}
