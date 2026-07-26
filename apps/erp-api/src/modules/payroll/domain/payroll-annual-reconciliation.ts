import {
  calculatePayroll,
  payrollDigest,
  type PayrollCalculationInput,
  type PayrollCalculationResult,
} from './payroll-calculation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const YEAR = /^\d{4}$/;

export interface AnnualPayrollWithholdingEntry {
  readonly period: string;
  readonly input: PayrollCalculationInput;
  readonly result: PayrollCalculationResult;
  readonly filingId: string;
  readonly filingEvidenceId: string;
  readonly filingStatus: 'submitted';
  readonly filedWithholdingTaxMinor: number;
}

export interface OfficialAnnualTaxAssessment {
  readonly assessmentId: string;
  readonly assessmentEvidenceId: string;
  readonly assessedTaxMinor: number;
  readonly sourceDigest: string;
}

export interface AnnualPayrollWithholdingReconciliationInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly taxYear: string;
  readonly entries: readonly AnnualPayrollWithholdingEntry[];
  readonly officialAssessment?: OfficialAnnualTaxAssessment;
}

export type AnnualPayrollWithholdingStatus =
  | 'awaiting_assessment'
  | 'assessment_matched'
  | 'requires_employee_settlement'
  | 'frozen';

export interface AnnualPayrollWithholdingReconciliationResult {
  readonly taxYear: string;
  readonly currency: 'CNY';
  readonly periodCount: number;
  readonly firstPeriod: string;
  readonly lastPeriod: string;
  readonly totalTaxableEarningsMinor: number;
  readonly totalPayrollWithheldMinor: number;
  readonly totalFiledWithholdingMinor: number;
  readonly cumulativeTaxLiabilityMinor: number;
  readonly officialAssessedTaxMinor: number | null;
  readonly employeePayableToTaxAuthorityMinor: number;
  readonly employeeRefundFromTaxAuthorityMinor: number;
  readonly differences: readonly ('MONTHLY_FILING_MISMATCH' | 'ANNUAL_FILING_TOTAL_MISMATCH')[];
  readonly status: AnnualPayrollWithholdingStatus;
  readonly evidenceHash: string;
}

export class AnnualPayrollReconciliationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AnnualPayrollReconciliationError';
  }
}

/**
 * 核对 ERP 工资累计预扣、逐月已提交清单和税局年度评估。
 * 税局评估为外部权威输入；本函数不替代个人综合所得申报，也不自动收付税款。
 */
export function reconcileAnnualPayrollWithholding(
  input: AnnualPayrollWithholdingReconciliationInput,
): AnnualPayrollWithholdingReconciliationResult {
  assertRoot(input);
  const entries = [...input.entries].sort((left, right) => left.period.localeCompare(right.period));
  if (new Set(entries.map((entry) => entry.period)).size !== entries.length) {
    invalid('PAYROLL_ANNUAL_PERIOD_DUPLICATED', '年度工资代扣期间重复');
  }
  let previous: PayrollCalculationResult | null = null;
  let totalTaxable = 0n;
  let totalPayrollWithheld = 0n;
  let totalFiled = 0n;
  const differences = new Set<
    'MONTHLY_FILING_MISMATCH' | 'ANNUAL_FILING_TOTAL_MISMATCH'
  >();
  for (const entry of entries) {
    assertEntry(input, entry);
    const recalculated = calculatePayroll(entry.input);
    if (payrollDigest(recalculated) !== payrollDigest(entry.result) ||
      recalculated.resultHash !== entry.result.resultHash) {
      invalid('PAYROLL_ANNUAL_RESULT_INTEGRITY_FAILED', '年度工资结果无法由冻结输入重放');
    }
    if (previous === null) {
      if (Object.values(entry.input.cumulativeBefore).some((value) => value !== 0)) {
        invalid('PAYROLL_ANNUAL_OPENING_BALANCE_INVALID', '年度首笔累计预扣状态必须从零开始');
      }
    } else if (
      payrollDigest(entry.input.cumulativeBefore) !== payrollDigest(previous.cumulativeAfter)
    ) {
      invalid('PAYROLL_ANNUAL_CUMULATIVE_CHAIN_BROKEN', '年度累计预扣状态链不连续');
    }
    if (entry.filedWithholdingTaxMinor !== entry.result.withholdingTaxMinor) {
      differences.add('MONTHLY_FILING_MISMATCH');
    }
    totalTaxable += BigInt(entry.result.taxableEarningsMinor);
    totalPayrollWithheld += BigInt(entry.result.withholdingTaxMinor);
    totalFiled += BigInt(entry.filedWithholdingTaxMinor);
    previous = entry.result;
  }
  const last = required(previous);
  if (totalFiled !== totalPayrollWithheld ||
    totalPayrollWithheld !== BigInt(last.cumulativeAfter.taxWithheldMinor)) {
    differences.add('ANNUAL_FILING_TOTAL_MISMATCH');
  }
  const totalPayrollWithheldMinor = signed(totalPayrollWithheld);
  const assessment = input.officialAssessment;
  const assessedTaxMinor = assessment?.assessedTaxMinor ?? null;
  const settlementDelta = assessment === undefined
    ? 0n : BigInt(assessment.assessedTaxMinor) - totalPayrollWithheld;
  const status: AnnualPayrollWithholdingStatus = differences.size > 0
    ? 'frozen'
    : assessment === undefined
      ? 'awaiting_assessment'
      : settlementDelta === 0n ? 'assessment_matched' : 'requires_employee_settlement';
  const publicResult = Object.freeze({
    taxYear: input.taxYear,
    currency: 'CNY' as const,
    periodCount: entries.length,
    firstPeriod: required(entries[0]).period,
    lastPeriod: required(entries.at(-1)).period,
    totalTaxableEarningsMinor: nonnegative(totalTaxable),
    totalPayrollWithheldMinor,
    totalFiledWithholdingMinor: signed(totalFiled),
    cumulativeTaxLiabilityMinor: last.cumulativeAfter.taxWithheldMinor,
    officialAssessedTaxMinor: assessedTaxMinor,
    employeePayableToTaxAuthorityMinor:
      settlementDelta > 0n ? nonnegative(settlementDelta) : 0,
    employeeRefundFromTaxAuthorityMinor:
      settlementDelta < 0n ? nonnegative(-settlementDelta) : 0,
    differences: Object.freeze([...differences].sort()),
    status,
  });
  const evidenceHash = payrollDigest({
    tenantId: input.tenantId, employeeId: input.employeeId, ...publicResult,
    sourceEvidence: Object.freeze({
      entries: Object.freeze(entries.map((entry) => Object.freeze({
        period: entry.period, resultHash: entry.result.resultHash,
        filingId: entry.filingId, filingEvidenceId: entry.filingEvidenceId,
        filedWithholdingTaxMinor: entry.filedWithholdingTaxMinor,
      }))),
      assessmentId: assessment?.assessmentId ?? null,
      assessmentEvidenceId: assessment?.assessmentEvidenceId ?? null,
      assessmentSourceDigest: assessment?.sourceDigest ?? null,
    }),
  });
  return Object.freeze({ ...publicResult, evidenceHash });
}

function assertRoot(input: AnnualPayrollWithholdingReconciliationInput): void {
  if (!ID.test(input.tenantId) || !ID.test(input.employeeId) || !YEAR.test(input.taxYear) ||
    input.entries.length < 1 || input.entries.length > 12) {
    invalid('PAYROLL_ANNUAL_INPUT_INVALID', '年度工资代扣核对根引用或期间数量非法');
  }
  const assessment = input.officialAssessment;
  if (assessment !== undefined &&
    (!ID.test(assessment.assessmentId) || !ID.test(assessment.assessmentEvidenceId) ||
      !HASH.test(assessment.sourceDigest) ||
      !Number.isSafeInteger(assessment.assessedTaxMinor) ||
      assessment.assessedTaxMinor < 0)) {
    invalid('PAYROLL_ANNUAL_ASSESSMENT_INVALID', '税局年度评估引用、摘要或税额非法');
  }
}

function assertEntry(
  root: AnnualPayrollWithholdingReconciliationInput,
  entry: AnnualPayrollWithholdingEntry,
): void {
  if (!new RegExp(`^${root.taxYear}-(0[1-9]|1[0-2])$`).test(entry.period) ||
    entry.input.tenantId !== root.tenantId || entry.input.employeeId !== root.employeeId ||
    entry.input.period !== entry.period || !ID.test(entry.filingId) ||
    !ID.test(entry.filingEvidenceId) || entry.filingStatus !== 'submitted' ||
    !Number.isSafeInteger(entry.filedWithholdingTaxMinor)) {
    invalid('PAYROLL_ANNUAL_ENTRY_INVALID', '年度工资代扣月度条目引用或金额非法');
  }
}

function signed(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    invalid('PAYROLL_ANNUAL_TOTAL_OVERFLOW', '年度工资代扣有符号汇总溢出');
  }
  return Number(value);
}

function nonnegative(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid('PAYROLL_ANNUAL_TOTAL_OVERFLOW', '年度工资代扣非负汇总溢出');
  }
  return Number(value);
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    invalid('PAYROLL_ANNUAL_ENTRY_REQUIRED', '年度工资代扣条目不能为空');
  }
  return value;
}

function invalid(code: string, message: string): never {
  throw new AnnualPayrollReconciliationError(code, message);
}
