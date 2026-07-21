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
    readonly bankSubmissionId: string; readonly bankSubmissionEvidenceId: string;
  };
  readonly bankReturn: {
    readonly returnId: string; readonly batchId: string; readonly returnHash: string;
    readonly outcome: 'accepted'; readonly successfulCount: number;
    readonly successfulMinor: number; readonly failedCount: number; readonly failedMinor: number;
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
  if (input.payroll.totalNetMinor !== input.disbursement.totalMinor) {
    differences.push('PAYROLL_BANK_AMOUNT_MISMATCH');
  }
  if (
    input.disbursement.totalMinor !== input.bankReturn.successfulMinor ||
    input.bankReturn.failedMinor !== 0
  ) differences.push('BANK_RETURN_AMOUNT_MISMATCH');
  if (
    input.disbursement.lineCount !== input.bankReturn.successfulCount ||
    input.bankReturn.failedCount !== 0
  ) differences.push('BANK_RETURN_COUNT_MISMATCH');
  if (
    input.payroll.totalWithholdingTaxMinor !== input.taxFiling.totalWithholdingTaxMinor
  ) differences.push('PAYROLL_TAX_AMOUNT_MISMATCH');
  if (input.payroll.employeeCount !== input.taxFiling.employeeCount) {
    differences.push('PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH');
  }
  const evidenceHash = digest({
    schema: 'PAYROLL_FOUR_WAY_RECONCILIATION_V1', tenantId: input.tenantId,
    payroll: input.payroll, disbursement: input.disbursement,
    bankReturn: input.bankReturn, taxFiling: input.taxFiling, differences,
  });
  return Object.freeze({
    balanced: differences.length === 0, differences: Object.freeze(differences), evidenceHash,
    employeeCount: input.payroll.employeeCount,
    bankLineCount: input.disbursement.lineCount,
    totalGrossMinor: input.payroll.totalGrossMinor,
    totalNetMinor: input.payroll.totalNetMinor,
    bankSubmittedMinor: input.disbursement.totalMinor,
    bankReturnedMinor: input.bankReturn.successfulMinor,
    totalTaxableEarningsMinor: input.taxFiling.totalTaxableEarningsMinor,
    payrollWithholdingTaxMinor: input.payroll.totalWithholdingTaxMinor,
    filedWithholdingTaxMinor: input.taxFiling.totalWithholdingTaxMinor,
  });
}

function assertShape(input: FourWayReconciliationInput): void {
  if (
    !ID.test(input.tenantId) ||
    ![input.payroll.periodId, input.payroll.payrollRunId, input.disbursement.batchId,
      input.disbursement.payrollPeriodId, input.disbursement.payrollRunId,
      input.bankReturn.returnId, input.bankReturn.batchId, input.taxFiling.filingId,
      input.taxFiling.payrollRunId].every((value) => ULID.test(value)) ||
    ![input.payroll.resultHash, input.disbursement.payrollResultHash,
      input.bankReturn.returnHash, input.taxFiling.payrollResultHash,
      input.taxFiling.contentHash].every((value) => HASH.test(value)) ||
    ![input.disbursement.bankSubmissionId, input.disbursement.bankSubmissionEvidenceId,
      input.taxFiling.taxSubmissionId,
      input.taxFiling.taxSubmissionEvidenceId].every((value) => ID.test(value)) ||
    !positive(input.payroll.employeeCount) || !positive(input.disbursement.lineCount) ||
    !nonnegative(input.payroll.totalGrossMinor) || !nonnegative(input.payroll.totalNetMinor) ||
    !signed(input.payroll.totalWithholdingTaxMinor) ||
    !nonnegative(input.disbursement.totalMinor) ||
    !nonnegative(input.bankReturn.successfulCount) || !nonnegative(input.bankReturn.failedCount) ||
    !nonnegative(input.bankReturn.successfulMinor) || !nonnegative(input.bankReturn.failedMinor) ||
    !positive(input.taxFiling.employeeCount) ||
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
function positive(value: number): boolean { return nonnegative(value) && value > 0; }
function signed(value: number): boolean { return Number.isSafeInteger(value); }
function invalid(code: string, message: string): never {
  throw new FourWayReconciliationError(code, message);
}
