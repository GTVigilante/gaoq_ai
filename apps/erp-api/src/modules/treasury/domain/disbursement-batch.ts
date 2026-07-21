export type DisbursementBatchStatus =
  | 'prepared' | 'exported' | 'submitted' | 'reconciling' | 'frozen' | 'reconciled';

export interface DisbursementBatch {
  readonly id: string;
  readonly tenantId: string;
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly format: 'ISO20022_PAIN_001_001_03';
  readonly fileHash: string;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly preparedBy: string;
  readonly payrollLockedBy: string;
  readonly exportApprovedBy: string | null;
  readonly strongAuthEvidenceId: string | null;
  readonly objectEvidenceId: string | null;
  readonly bankSubmissionId: string | null;
  readonly bankSubmissionEvidenceId: string | null;
  readonly returnHash: string | null;
  readonly successfulCount: number | null;
  readonly failedCount: number | null;
  readonly successfulMinor: number | null;
  readonly failedMinor: number | null;
  readonly freezeReason: string | null;
  readonly status: DisbursementBatchStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DisbursementBatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DisbursementBatchError';
  }
}

export function createDisbursementBatch(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly fileHash: string;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly preparedBy: string;
  readonly payrollLockedBy: string;
}, now: Date): DisbursementBatch {
  assertIds(input);
  assertHash(input.fileHash);
  assertCount(input.lineCount);
  assertAmount(input.totalMinor);
  if (input.preparedBy === input.payrollLockedBy) {
    invalid('TREASURY_DUAL_CONTROL_REQUIRED', '代发制备人不得是工资锁定人');
  }
  const occurredAt = iso(now);
  return Object.freeze({
    id: input.id, tenantId: input.tenantId,
    payrollPeriodId: input.payrollPeriodId, payrollRunId: input.payrollRunId,
    format: 'ISO20022_PAIN_001_001_03', fileHash: input.fileHash,
    lineCount: input.lineCount, totalMinor: input.totalMinor, preparedBy: input.preparedBy,
    payrollLockedBy: input.payrollLockedBy,
    exportApprovedBy: null, strongAuthEvidenceId: null, objectEvidenceId: null,
    bankSubmissionId: null, bankSubmissionEvidenceId: null, returnHash: null,
    successfulCount: null, failedCount: null, successfulMinor: null, failedMinor: null,
    freezeReason: null, status: 'prepared', version: 1,
    createdAt: occurredAt, updatedAt: occurredAt,
  });
}

export function approveDisbursementExport(
  batch: DisbursementBatch,
  command: BaseCommand & {
    readonly approvedBy: string;
    readonly strongAuthEvidenceId: string;
    readonly objectEvidenceId: string;
  },
  now: Date,
): DisbursementBatch {
  assertCommand(batch, command, 'prepared');
  assertIds(command);
  if (command.approvedBy === batch.preparedBy || command.approvedBy === batch.payrollLockedBy) {
    invalid('TREASURY_DUAL_CONTROL_REQUIRED', '导出批准人必须独立于代发制备人和工资锁定人');
  }
  return next(batch, {
    status: 'exported', exportApprovedBy: command.approvedBy,
    strongAuthEvidenceId: command.strongAuthEvidenceId,
    objectEvidenceId: command.objectEvidenceId,
  }, now);
}

export function recordBankSubmission(
  batch: DisbursementBatch,
  command: BaseCommand & {
    readonly bankSubmissionId: string;
    readonly bankSubmissionEvidenceId: string;
    readonly trustedConnector: boolean;
  },
  now: Date,
): DisbursementBatch {
  assertCommand(batch, command, 'exported');
  assertIds(command);
  if (!command.trustedConnector) invalid('TREASURY_BANK_SUBMISSION_UNTRUSTED', '银行提交证据不可信');
  return next(batch, {
    status: 'submitted', bankSubmissionId: command.bankSubmissionId,
    bankSubmissionEvidenceId: command.bankSubmissionEvidenceId,
  }, now);
}

export function applyBankReturn(
  batch: DisbursementBatch,
  command: BaseCommand & {
    readonly returnHash: string;
    readonly signatureVerified: boolean;
    readonly successfulCount: number;
    readonly failedCount: number;
    readonly unknownCount: number;
    readonly duplicateCount: number;
    readonly successfulMinor: number;
    readonly failedMinor: number;
  },
  now: Date,
): DisbursementBatch {
  assertCommand(batch, command, 'submitted');
  assertHash(command.returnHash);
  for (const count of [
    command.successfulCount, command.failedCount, command.unknownCount, command.duplicateCount,
  ]) if (!Number.isSafeInteger(count) || count < 0) {
    invalid('TREASURY_RETURN_COUNT_INVALID', '银行回盘行数非法');
  }
  assertAmount(command.successfulMinor, true);
  assertAmount(command.failedMinor, true);
  const countBalanced = command.successfulCount + command.failedCount === batch.lineCount;
  const amountBalanced = safeSum(command.successfulMinor, command.failedMinor) === batch.totalMinor;
  const clean = command.signatureVerified && command.unknownCount === 0 &&
    command.duplicateCount === 0 && countBalanced && amountBalanced && command.failedCount === 0;
  const reason = !command.signatureVerified ? 'SIGNATURE_INVALID'
    : command.unknownCount > 0 ? 'UNKNOWN_LINE'
    : command.duplicateCount > 0 ? 'DUPLICATE_LINE'
    : !countBalanced ? 'COUNT_MISMATCH'
    : !amountBalanced ? 'AMOUNT_MISMATCH'
    : command.failedCount > 0 ? 'PARTIAL_SUCCESS'
    : null;
  return next(batch, {
    status: clean ? 'reconciling' : 'frozen', returnHash: command.returnHash,
    successfulCount: command.successfulCount, failedCount: command.failedCount,
    successfulMinor: command.successfulMinor, failedMinor: command.failedMinor,
    freezeReason: reason,
  }, now);
}

interface BaseCommand { readonly tenantId: string; readonly expectedVersion: number }

function assertCommand(
  batch: DisbursementBatch,
  command: BaseCommand,
  status: DisbursementBatchStatus,
): void {
  if (command.tenantId !== batch.tenantId) invalid('TREASURY_TENANT_MISMATCH', '代发批次租户不匹配');
  if (command.expectedVersion !== batch.version) invalid('TREASURY_VERSION_CONFLICT', '代发批次版本冲突');
  if (batch.status !== status) invalid('TREASURY_TRANSITION_INVALID', '代发批次状态迁移无效');
}

function next(
  batch: DisbursementBatch,
  changes: Partial<DisbursementBatch>,
  now: Date,
): DisbursementBatch {
  return Object.freeze({
    ...batch, ...changes, id: batch.id, tenantId: batch.tenantId,
    version: batch.version + 1, createdAt: batch.createdAt, updatedAt: iso(now),
  });
}

function assertIds(values: object): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && /(?:id|by)$/iu.test(key) &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      invalid('TREASURY_IDENTIFIER_INVALID', '代发标识非法');
    }
  }
}

function assertHash(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) invalid('TREASURY_HASH_INVALID', '代发摘要非法');
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    invalid('TREASURY_LINE_COUNT_INVALID', '代发行数非法');
  }
}

function assertAmount(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    invalid('TREASURY_AMOUNT_INVALID', '代发金额非法');
  }
}

function safeSum(left: number, right: number): number {
  const result = BigInt(left) + BigInt(right);
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(result);
}

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) invalid('TREASURY_TIME_INVALID', '代发时间非法');
  return value.toISOString();
}

function invalid(code: string, message: string): never {
  throw new DisbursementBatchError(code, message);
}
