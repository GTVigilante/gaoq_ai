import {
  payrollDigest,
  type PayrollCalculationResult,
} from './payroll-calculation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;

export type PayrollAdjustmentType = 'supplement' | 'reversal' | 'tax_only';

export interface PayrollAdjustmentInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly originalCalculationLineId: string;
  readonly reasonCode: string;
  readonly originalPeriodStatus:
    | 'locked'
    | 'disbursing'
    | 'reconciling'
    | 'reconciled';
  readonly original: PayrollCalculationResult;
  readonly corrected: PayrollCalculationResult;
}

export interface PayrollAdjustmentDelta {
  readonly grossPayMinor: number;
  readonly taxableEarningsMinor: number;
  readonly withholdingTaxMinor: number;
  readonly netPayMinor: number;
  readonly cumulativeAfter: PayrollAdjustmentCumulativeDelta;
}

export interface PayrollAdjustmentCumulativeDelta {
  readonly taxableIncomeMinor: number;
  readonly basicDeductionMinor: number;
  readonly socialInsuranceMinor: number;
  readonly housingFundMinor: number;
  readonly specialAdditionalDeductionMinor: number;
  readonly otherDeductionMinor: number;
  readonly taxWithheldMinor: number;
}

export interface PayrollAdjustmentResult {
  readonly type: PayrollAdjustmentType;
  readonly currency: 'CNY';
  readonly originalCalculationLineId: string;
  readonly originalInputHash: string;
  readonly originalResultHash: string;
  readonly correctedInputHash: string;
  readonly correctedResultHash: string;
  readonly reasonCode: string;
  readonly delta: PayrollAdjustmentDelta;
  /** 仅正向现金差额可进入补发支付链。 */
  readonly payableMinor: number;
  /** 负向现金差额只能进入独立扣回/应收链，绝不生成负数银行指令。 */
  readonly receivableMinor: number;
  readonly adjustmentHash: string;
}

export class PayrollAdjustmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PayrollAdjustmentError';
  }
}

/**
 * 从已锁定原结果与服务端重算结果生成不可变差额。
 * 本函数不接收客户端金额，也不执行代发、扣款或税务重报。
 */
export function createPayrollAdjustment(input: PayrollAdjustmentInput): PayrollAdjustmentResult {
  assertInput(input);
  assertResultIntegrity(input.original, 'ORIGINAL');
  assertResultIntegrity(input.corrected, 'CORRECTED');
  if (input.original.inputHash === input.corrected.inputHash) {
    invalid('PAYROLL_ADJUSTMENT_INPUT_UNCHANGED', '更正输入与原输入相同，不得创建调整');
  }
  const delta: PayrollAdjustmentDelta = Object.freeze({
    grossPayMinor: difference(
      input.corrected.grossPayMinor, input.original.grossPayMinor,
    ),
    taxableEarningsMinor: difference(
      input.corrected.taxableEarningsMinor, input.original.taxableEarningsMinor,
    ),
    withholdingTaxMinor: difference(
      input.corrected.withholdingTaxMinor, input.original.withholdingTaxMinor,
    ),
    netPayMinor: difference(
      input.corrected.netPayMinor, input.original.netPayMinor,
    ),
    cumulativeAfter: Object.freeze({
      taxableIncomeMinor: difference(
        input.corrected.cumulativeAfter.taxableIncomeMinor,
        input.original.cumulativeAfter.taxableIncomeMinor,
      ),
      basicDeductionMinor: difference(
        input.corrected.cumulativeAfter.basicDeductionMinor,
        input.original.cumulativeAfter.basicDeductionMinor,
      ),
      socialInsuranceMinor: difference(
        input.corrected.cumulativeAfter.socialInsuranceMinor,
        input.original.cumulativeAfter.socialInsuranceMinor,
      ),
      housingFundMinor: difference(
        input.corrected.cumulativeAfter.housingFundMinor,
        input.original.cumulativeAfter.housingFundMinor,
      ),
      specialAdditionalDeductionMinor: difference(
        input.corrected.cumulativeAfter.specialAdditionalDeductionMinor,
        input.original.cumulativeAfter.specialAdditionalDeductionMinor,
      ),
      otherDeductionMinor: difference(
        input.corrected.cumulativeAfter.otherDeductionMinor,
        input.original.cumulativeAfter.otherDeductionMinor,
      ),
      taxWithheldMinor: difference(
        input.corrected.cumulativeAfter.taxWithheldMinor,
        input.original.cumulativeAfter.taxWithheldMinor,
      ),
    }),
  });
  if (
    delta.grossPayMinor === 0 &&
    delta.taxableEarningsMinor === 0 &&
    delta.withholdingTaxMinor === 0 &&
    delta.netPayMinor === 0 &&
    Object.values(delta.cumulativeAfter).every((item) => item === 0)
  ) {
    invalid('PAYROLL_ADJUSTMENT_DELTA_ZERO', '服务端重算未形成任何工资或税务差额');
  }
  const type: PayrollAdjustmentType = delta.netPayMinor > 0
    ? 'supplement'
    : delta.netPayMinor < 0 ? 'reversal' : 'tax_only';
  const withoutHash = Object.freeze({
    type,
    currency: 'CNY' as const,
    originalCalculationLineId: input.originalCalculationLineId,
    originalInputHash: input.original.inputHash,
    originalResultHash: input.original.resultHash,
    correctedInputHash: input.corrected.inputHash,
    correctedResultHash: input.corrected.resultHash,
    reasonCode: input.reasonCode,
    delta,
    payableMinor: delta.netPayMinor > 0 ? delta.netPayMinor : 0,
    receivableMinor: delta.netPayMinor < 0 ? -delta.netPayMinor : 0,
  });
  return Object.freeze({
    ...withoutHash,
    adjustmentHash: payrollDigest({
      tenantId: input.tenantId, employeeId: input.employeeId,
      period: input.period, ...withoutHash,
    }),
  });
}

function assertInput(input: PayrollAdjustmentInput): void {
  if (!ID.test(input.tenantId) || !ID.test(input.employeeId) ||
    !MONTH.test(input.period) || !ULID.test(input.originalCalculationLineId) ||
    !REASON.test(input.reasonCode) ||
    !['locked', 'disbursing', 'reconciling', 'reconciled'].includes(input.originalPeriodStatus)) {
    invalid('PAYROLL_ADJUSTMENT_REFERENCE_INVALID', '工资调整引用、原因或原周期状态非法');
  }
}

function assertResultIntegrity(
  result: PayrollCalculationResult,
  side: 'ORIGINAL' | 'CORRECTED',
): void {
  const {
    resultHash,
    ...withoutHash
  } = result;
  if (!HASH.test(result.inputHash) || !HASH.test(resultHash) ||
    payrollDigest(withoutHash) !== resultHash) {
    invalid(`PAYROLL_ADJUSTMENT_${side}_INTEGRITY_FAILED`, `${side} 工资结果摘要不一致`);
  }
}

function difference(corrected: number, original: number): number {
  if (!Number.isSafeInteger(corrected) || !Number.isSafeInteger(original)) {
    invalid('PAYROLL_ADJUSTMENT_AMOUNT_INVALID', '工资调整金额必须为安全整数分');
  }
  const value = BigInt(corrected) - BigInt(original);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    invalid('PAYROLL_ADJUSTMENT_AMOUNT_OVERFLOW', '工资调整差额超出安全整数范围');
  }
  return Number(value);
}

function invalid(code: string, message: string): never {
  throw new PayrollAdjustmentError(code, message);
}
