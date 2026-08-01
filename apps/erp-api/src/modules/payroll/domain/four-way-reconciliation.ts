import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

export type PayrollReconciliationDifferenceCode =
  | 'PAYROLL_BANK_AMOUNT_MISMATCH'
  | 'BANK_RETURN_AMOUNT_MISMATCH'
  | 'BANK_RETURN_COUNT_MISMATCH'
  | 'PAYROLL_TAX_AMOUNT_MISMATCH'
  | 'PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH';

export interface FourWayReconciliationInput {
  readonly tenantId: string;
  readonly payroll: {
    readonly periodId: string; readonly payrollRunId: string; readonly resultHash: string;
    readonly employeeCount: number; readonly totalGrossMinor: number;
    readonly totalNetMinor: number; readonly totalWithholdingTaxMinor: number;
  };
  readonly disbursement: {
    readonly batchId: string; readonly payrollPeriodId: string; readonly payrollRunId: string;
    readonly payrollResultHash: string; readonly status: 'reconciling';
    readonly lineCount: number; readonly totalMinor: number;
    readonly settledLineCount: number; readonly settledMinor: number;
    readonly settlementChainHash: string;
    readonly objectEvidenceId: string;
    readonly bankSubmissionId: string; readonly bankSubmissionEvidenceId: string;
  };
  readonly bankReturn: {
    readonly returnId: string; readonly batchId: string; readonly returnHash: string;
    readonly outcome: 'accepted'; readonly successfulCount: number;
    readonly successfulMinor: number; readonly failedCount: number; readonly failedMinor: number;
    readonly objectEvidenceId: string; readonly signatureEvidenceId: string;
    readonly malwareScanEvidenceId: string;
  };
  readonly taxFiling: {
    readonly filingId: string; readonly payrollRunId: string; readonly payrollResultHash: string;
    readonly status: 'submitted'; readonly employeeCount: number;
    readonly totalTaxableEarningsMinor: number; readonly totalWithholdingTaxMinor: number;
    readonly contentHash: string; readonly taxSubmissionId: string;
    readonly taxSubmissionEvidenceId: string;
  };
}

export interface FourWayReconciliationResult {
  readonly balanced: boolean;
  readonly differences: readonly PayrollReconciliationDifferenceCode[];
  readonly evidenceHash: string;
  readonly employeeCount: number;
  readonly bankLineCount: number;
  readonly totalGrossMinor: number;
  readonly totalNetMinor: number;
  readonly bankSubmittedMinor: number;
  readonly bankReturnedMinor: number;
  readonly totalTaxableEarningsMinor: number;
  readonly payrollWithholdingTaxMinor: number;
  readonly filedWithholdingTaxMinor: number;
}

export class FourWayReconciliationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FourWayReconciliationError';
  }
}

/** 对锁定应发、代发、终态回盘和已提交个税执行确定性控制量守恒。 */
export function reconcilePayrollFourWay(
  input: FourWayReconciliationInput,
): FourWayReconciliationResult {
  assertShape(input);
  assertBindings(input);
  const differences: PayrollReconciliationDifferenceCode[] = [];
  if (input.payroll.totalNetMinor !== input.disbursement.settledMinor) {
    differences.push('PAYROLL_BANK_AMOUNT_MISMATCH');
  }
  if (
    input.disbursement.totalMinor !== input.bankReturn.successfulMinor ||
    input.bankReturn.failedMinor !== 0
  ) differences.push('BANK_RETURN_AMOUNT_MISMATCH');
  if (
    input.disbursement.lineCount !== input.bankReturn.successfulCount ||
    input.bankReturn.failedCount !== 0 ||
    input.disbursement.settledLineCount > input.payroll.employeeCount
  ) differences.push('BANK_RETURN_COUNT_MISMATCH');
  if (
    input.payroll.totalWithholdingTaxMinor !== input.taxFiling.totalWithholdingTaxMinor
  ) differences.push('PAYROLL_TAX_AMOUNT_MISMATCH');
  if (input.payroll.employeeCount !== input.taxFiling.employeeCount) {
    differences.push('PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH');
  }
  const evidenceHash = digest(canonicalEvidence(input, differences));
  return Object.freeze({
    balanced: differences.length === 0, differences: Object.freeze(differences), evidenceHash,
    employeeCount: input.payroll.employeeCount,
    bankLineCount: input.disbursement.settledLineCount,
    totalGrossMinor: input.payroll.totalGrossMinor,
    totalNetMinor: input.payroll.totalNetMinor,
    bankSubmittedMinor: input.disbursement.settledMinor,
    bankReturnedMinor: input.disbursement.settledMinor,
    totalTaxableEarningsMinor: input.taxFiling.totalTaxableEarningsMinor,
    payrollWithholdingTaxMinor: input.payroll.totalWithholdingTaxMinor,
    filedWithholdingTaxMinor: input.taxFiling.totalWithholdingTaxMinor,
  });
}

function canonicalEvidence(
  input: FourWayReconciliationInput,
  differences: readonly PayrollReconciliationDifferenceCode[],
) {
  return {
    schema: 'PAYROLL_FOUR_WAY_RECONCILIATION_V1', tenantId: input.tenantId,
    payroll: {
      periodId: input.payroll.periodId, payrollRunId: input.payroll.payrollRunId,
      resultHash: input.payroll.resultHash, employeeCount: input.payroll.employeeCount,
      totalGrossMinor: input.payroll.totalGrossMinor,
      totalNetMinor: input.payroll.totalNetMinor,
      totalWithholdingTaxMinor: input.payroll.totalWithholdingTaxMinor,
    },
    disbursement: {
      batchId: input.disbursement.batchId,
      payrollPeriodId: input.disbursement.payrollPeriodId,
      payrollRunId: input.disbursement.payrollRunId,
      payrollResultHash: input.disbursement.payrollResultHash,
      status: input.disbursement.status, lineCount: input.disbursement.lineCount,
      totalMinor: input.disbursement.totalMinor,
      settledLineCount: input.disbursement.settledLineCount,
      settledMinor: input.disbursement.settledMinor,
      settlementChainHash: input.disbursement.settlementChainHash,
      objectEvidenceId: input.disbursement.objectEvidenceId,
      bankSubmissionId: input.disbursement.bankSubmissionId,
      bankSubmissionEvidenceId: input.disbursement.bankSubmissionEvidenceId,
    },
    bankReturn: {
      returnId: input.bankReturn.returnId, batchId: input.bankReturn.batchId,
      returnHash: input.bankReturn.returnHash, outcome: input.bankReturn.outcome,
      successfulCount: input.bankReturn.successfulCount,
      successfulMinor: input.bankReturn.successfulMinor,
      failedCount: input.bankReturn.failedCount, failedMinor: input.bankReturn.failedMinor,
      objectEvidenceId: input.bankReturn.objectEvidenceId,
      signatureEvidenceId: input.bankReturn.signatureEvidenceId,
      malwareScanEvidenceId: input.bankReturn.malwareScanEvidenceId,
    },
    taxFiling: {
      filingId: input.taxFiling.filingId, payrollRunId: input.taxFiling.payrollRunId,
      payrollResultHash: input.taxFiling.payrollResultHash, status: input.taxFiling.status,
      employeeCount: input.taxFiling.employeeCount,
      totalTaxableEarningsMinor: input.taxFiling.totalTaxableEarningsMinor,
      totalWithholdingTaxMinor: input.taxFiling.totalWithholdingTaxMinor,
      contentHash: input.taxFiling.contentHash,
      taxSubmissionId: input.taxFiling.taxSubmissionId,
      taxSubmissionEvidenceId: input.taxFiling.taxSubmissionEvidenceId,
    },
    differences: [...differences],
  };
}

function assertShape(input: FourWayReconciliationInput): void {
  if (
    !ID.test(input.tenantId) ||
    ![input.payroll.periodId, input.payroll.payrollRunId, input.disbursement.batchId,
      input.disbursement.payrollPeriodId, input.disbursement.payrollRunId,
      input.bankReturn.returnId, input.bankReturn.batchId, input.taxFiling.filingId,
      input.taxFiling.payrollRunId].every((value) => ULID.test(value)) ||
    ![input.payroll.resultHash, input.disbursement.payrollResultHash,
      input.disbursement.settlementChainHash,
      input.bankReturn.returnHash, input.taxFiling.payrollResultHash,
      input.taxFiling.contentHash].every((value) => HASH.test(value)) ||
    ![input.disbursement.objectEvidenceId, input.disbursement.bankSubmissionId,
      input.disbursement.bankSubmissionEvidenceId, input.bankReturn.objectEvidenceId,
      input.bankReturn.signatureEvidenceId, input.bankReturn.malwareScanEvidenceId,
      input.taxFiling.taxSubmissionId,
      input.taxFiling.taxSubmissionEvidenceId].every((value) => ID.test(value)) ||
    !boundedPositive(input.payroll.employeeCount) ||
    !boundedPositive(input.disbursement.lineCount) ||
    !boundedPositive(input.disbursement.settledLineCount) ||
    !nonnegative(input.payroll.totalGrossMinor) || !nonnegative(input.payroll.totalNetMinor) ||
    !signed(input.payroll.totalWithholdingTaxMinor) ||
    !nonnegative(input.disbursement.totalMinor) || !nonnegative(input.disbursement.settledMinor) ||
    !boundedCount(input.bankReturn.successfulCount) ||
    !boundedCount(input.bankReturn.failedCount) ||
    !nonnegative(input.bankReturn.successfulMinor) || !nonnegative(input.bankReturn.failedMinor) ||
    !boundedPositive(input.taxFiling.employeeCount) ||
    !nonnegative(input.taxFiling.totalTaxableEarningsMinor) ||
    !signed(input.taxFiling.totalWithholdingTaxMinor)
  ) invalid('PAYROLL_RECONCILIATION_INPUT_INVALID', '四方对账引用或控制量非法');
}

function assertBindings(input: FourWayReconciliationInput): void {
  if (
    input.disbursement.payrollPeriodId !== input.payroll.periodId ||
    input.disbursement.payrollRunId !== input.payroll.payrollRunId ||
    input.disbursement.payrollResultHash !== input.payroll.resultHash ||
    input.bankReturn.batchId !== input.disbursement.batchId ||
    input.taxFiling.payrollRunId !== input.payroll.payrollRunId ||
    input.taxFiling.payrollResultHash !== input.payroll.resultHash
  ) invalid('PAYROLL_RECONCILIATION_BINDING_MISMATCH', '四方证据未绑定同一工资运行');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url');
}

function nonnegative(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function boundedCount(value: number): boolean { return nonnegative(value) && value <= 5_000; }
function boundedPositive(value: number): boolean { return boundedCount(value) && value > 0; }
function signed(value: number): boolean { return Number.isSafeInteger(value); }
function invalid(code: string, message: string): never {
  throw new FourWayReconciliationError(code, message);
}
