import { createHash } from 'node:crypto';

export interface PayrollAmountComponent {
  readonly code: string;
  readonly amountMinor: number;
}

export interface CumulativeWithholdingState {
  readonly taxableIncomeMinor: number;
  readonly basicDeductionMinor: number;
  readonly socialInsuranceMinor: number;
  readonly housingFundMinor: number;
  readonly specialAdditionalDeductionMinor: number;
  readonly otherDeductionMinor: number;
  readonly taxWithheldMinor: number;
}

export interface CumulativeTaxBracket {
  /** null 表示最后一个无上限档。 */
  readonly upperBoundMinor: number | null;
  readonly rateBps: number;
  readonly quickDeductionMinor: number;
}

export interface PayrollRulePackSnapshot {
  readonly id: string;
  readonly version: number;
  readonly monthlyBasicDeductionMinor: number;
  readonly taxBrackets: readonly CumulativeTaxBracket[];
  readonly roundingMode: 'HALF_UP';
}

export interface PayrollCalculationInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly currency: 'CNY';
  readonly engineVersion: string;
  readonly rulePack: PayrollRulePackSnapshot;
  readonly taxableEarnings: readonly PayrollAmountComponent[];
  readonly nonTaxableEarnings: readonly PayrollAmountComponent[];
  readonly employeeSocialInsuranceMinor: number;
  readonly employeeHousingFundMinor: number;
  /** 只减少计税基础，不从实发现金再次扣除。 */
  readonly specialAdditionalDeductionMinor: number;
  readonly otherPreTaxWithholdingMinor: number;
  readonly postTaxDeductionMinor: number;
  readonly cumulativeBefore: CumulativeWithholdingState;
}

export interface PayrollCalculationStep {
  readonly sequence: number;
  readonly code:
    | 'gross_pay'
    | 'cumulative_taxable_income'
    | 'cumulative_tax_liability'
    | 'withholding_tax'
    | 'net_pay';
  readonly amountMinor: number;
  readonly inputDigest: string;
  readonly ruleVersion: number;
  readonly roundingMode: 'HALF_UP';
}

export interface PayrollCalculationResult {
  readonly currency: 'CNY';
  readonly grossPayMinor: number;
  readonly taxableEarningsMinor: number;
  readonly withholdingTaxMinor: number;
  readonly netPayMinor: number;
  readonly cumulativeAfter: CumulativeWithholdingState;
  readonly steps: readonly PayrollCalculationStep[];
  readonly resultHash: string;
}

export class PayrollCalculationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PayrollCalculationError';
  }
}

/** 确定性累计预扣内核；所有乘除均转为 bigint，输出前再校验安全整数。 */
export function calculatePayroll(input: PayrollCalculationInput): PayrollCalculationResult {
  validateInput(input);
  const taxableComponents = normalizedComponents(input.taxableEarnings, 'taxableEarnings');
  const nonTaxableComponents = normalizedComponents(input.nonTaxableEarnings, 'nonTaxableEarnings');
  const taxableEarnings = sum(taxableComponents.map((item) => item.amountMinor));
  const nonTaxableEarnings = sum(nonTaxableComponents.map((item) => item.amountMinor));
  const grossPay = taxableEarnings + nonTaxableEarnings;
  const cumulativeBase = {
    taxableIncomeMinor: safeAdd(input.cumulativeBefore.taxableIncomeMinor, taxableEarnings),
    basicDeductionMinor: safeAdd(
      input.cumulativeBefore.basicDeductionMinor,
      input.rulePack.monthlyBasicDeductionMinor,
    ),
    socialInsuranceMinor: safeAdd(
      input.cumulativeBefore.socialInsuranceMinor,
      input.employeeSocialInsuranceMinor,
    ),
    housingFundMinor: safeAdd(
      input.cumulativeBefore.housingFundMinor,
      input.employeeHousingFundMinor,
    ),
    specialAdditionalDeductionMinor: safeAdd(
      input.cumulativeBefore.specialAdditionalDeductionMinor,
      input.specialAdditionalDeductionMinor,
    ),
    otherDeductionMinor: safeAdd(
      input.cumulativeBefore.otherDeductionMinor,
      input.otherPreTaxWithholdingMinor,
    ),
  };
  const cumulativeTaxable = maxZero(
    BigInt(cumulativeBase.taxableIncomeMinor) -
    BigInt(cumulativeBase.basicDeductionMinor) -
    BigInt(cumulativeBase.socialInsuranceMinor) -
    BigInt(cumulativeBase.housingFundMinor) -
    BigInt(cumulativeBase.specialAdditionalDeductionMinor) -
    BigInt(cumulativeBase.otherDeductionMinor),
  );
  const bracket = input.rulePack.taxBrackets.find((item) =>
    item.upperBoundMinor === null || cumulativeTaxable <= BigInt(item.upperBoundMinor));
  if (bracket === undefined) invalid('PAYROLL_TAX_BRACKET_NOT_FOUND', '累计计税所得未命中税率档');
  const cumulativeTaxLiability = maxZero(
    divideHalfUp(cumulativeTaxable * BigInt(bracket.rateBps), 10_000n) -
    BigInt(bracket.quickDeductionMinor),
  );
  const withholdingTax = cumulativeTaxLiability - BigInt(input.cumulativeBefore.taxWithheldMinor);
  const cumulativeAfter: CumulativeWithholdingState = Object.freeze({
    ...cumulativeBase,
    taxWithheldMinor: toSafeMinor(cumulativeTaxLiability),
  });
  const netPay = BigInt(grossPay) - BigInt(input.employeeSocialInsuranceMinor) -
    BigInt(input.employeeHousingFundMinor) - BigInt(input.otherPreTaxWithholdingMinor) -
    withholdingTax - BigInt(input.postTaxDeductionMinor);
  if (netPay < 0n) invalid('PAYROLL_NET_PAY_NEGATIVE', '实发金额不能为负');

  const normalizedInput = Object.freeze({
    tenantId: input.tenantId, employeeId: input.employeeId, period: input.period,
    currency: input.currency, engineVersion: input.engineVersion,
    rulePack: Object.freeze({
      ...input.rulePack,
      taxBrackets: Object.freeze(input.rulePack.taxBrackets.map((item) => Object.freeze({ ...item }))),
    }),
    taxableEarnings: taxableComponents, nonTaxableEarnings: nonTaxableComponents,
    employeeSocialInsuranceMinor: input.employeeSocialInsuranceMinor,
    employeeHousingFundMinor: input.employeeHousingFundMinor,
    specialAdditionalDeductionMinor: input.specialAdditionalDeductionMinor,
    otherPreTaxWithholdingMinor: input.otherPreTaxWithholdingMinor,
    postTaxDeductionMinor: input.postTaxDeductionMinor,
    cumulativeBefore: Object.freeze({ ...input.cumulativeBefore }),
  });
  const inputDigest = hash(normalizedInput);
  const amounts = [
    ['gross_pay', BigInt(grossPay)],
    ['cumulative_taxable_income', cumulativeTaxable],
    ['cumulative_tax_liability', cumulativeTaxLiability],
    ['withholding_tax', withholdingTax],
    ['net_pay', netPay],
  ] as const;
  const steps: readonly PayrollCalculationStep[] = Object.freeze(amounts.map(
    ([code, amount], index) => Object.freeze({
      sequence: index + 1, code,
      amountMinor: code === 'withholding_tax' ? toSafeSignedMinor(amount) : toSafeMinor(amount),
      inputDigest,
      ruleVersion: input.rulePack.version, roundingMode: input.rulePack.roundingMode,
    }),
  ));
  const resultWithoutHash = Object.freeze({
    currency: input.currency,
    grossPayMinor: grossPay,
    taxableEarningsMinor: taxableEarnings,
    withholdingTaxMinor: toSafeSignedMinor(withholdingTax),
    netPayMinor: toSafeMinor(netPay),
    cumulativeAfter: Object.freeze({ ...cumulativeAfter }),
    steps,
  });
  return Object.freeze({ ...resultWithoutHash, resultHash: hash(resultWithoutHash) });
}

function validateInput(input: PayrollCalculationInput): void {
  for (const [field, value] of Object.entries({
    tenantId: input.tenantId, employeeId: input.employeeId,
    engineVersion: input.engineVersion, rulePackId: input.rulePack.id,
  })) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid('PAYROLL_IDENTIFIER_INVALID', `${field} 标识非法`);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    invalid('PAYROLL_PERIOD_INVALID', '工资期间必须为 YYYY-MM');
  }
  if (!Number.isSafeInteger(input.rulePack.version) || input.rulePack.version < 1) {
    invalid('PAYROLL_RULE_VERSION_INVALID', '规则版本非法');
  }
  for (const [field, amount] of Object.entries({
    monthlyBasicDeductionMinor: input.rulePack.monthlyBasicDeductionMinor,
    employeeSocialInsuranceMinor: input.employeeSocialInsuranceMinor,
    employeeHousingFundMinor: input.employeeHousingFundMinor,
    currentSpecialAdditionalDeductionMinor: input.specialAdditionalDeductionMinor,
    otherPreTaxWithholdingMinor: input.otherPreTaxWithholdingMinor,
    postTaxDeductionMinor: input.postTaxDeductionMinor,
    ...input.cumulativeBefore,
  })) assertMinor(amount, field);
  if (input.rulePack.roundingMode !== 'HALF_UP') {
    invalid('PAYROLL_ROUNDING_MODE_UNSUPPORTED', '首期只支持显式 HALF_UP 舍入');
  }
  if (input.rulePack.taxBrackets.length < 1) invalid('PAYROLL_TAX_BRACKETS_INVALID', '税率表不能为空');
  let previous = -1;
  input.rulePack.taxBrackets.forEach((bracket, index) => {
    if (!Number.isInteger(bracket.rateBps) || bracket.rateBps < 0 || bracket.rateBps > 10_000) {
      invalid('PAYROLL_TAX_RATE_INVALID', '税率基点非法');
    }
    assertMinor(bracket.quickDeductionMinor, 'quickDeductionMinor');
    if (bracket.upperBoundMinor === null) {
      if (index !== input.rulePack.taxBrackets.length - 1) {
        invalid('PAYROLL_TAX_BRACKETS_INVALID', '无上限税率档只能位于最后');
      }
    } else {
      assertMinor(bracket.upperBoundMinor, 'upperBoundMinor');
      if (bracket.upperBoundMinor <= previous) {
        invalid('PAYROLL_TAX_BRACKETS_INVALID', '税率档上限必须严格递增');
      }
      previous = bracket.upperBoundMinor;
    }
    const previousBracket = input.rulePack.taxBrackets[index - 1];
    if (previousBracket !== undefined && previousBracket.upperBoundMinor !== null) {
      if (bracket.rateBps < previousBracket.rateBps) {
        invalid('PAYROLL_TAX_BRACKETS_INVALID', '税率必须单调不降');
      }
      const boundary = BigInt(previousBracket.upperBoundMinor);
      const priorTax = divideHalfUp(boundary * BigInt(previousBracket.rateBps), 10_000n) -
        BigInt(previousBracket.quickDeductionMinor);
      const currentTax = divideHalfUp(boundary * BigInt(bracket.rateBps), 10_000n) -
        BigInt(bracket.quickDeductionMinor);
      if (priorTax !== currentTax) {
        invalid('PAYROLL_TAX_BRACKETS_INVALID', '税率档与速算扣除数在边界不连续');
      }
    }
  });
  if (input.rulePack.taxBrackets.at(-1)?.upperBoundMinor !== null) {
    invalid('PAYROLL_TAX_BRACKETS_INVALID', '税率表必须包含最终无上限档');
  }
}

function normalizedComponents(
  values: readonly PayrollAmountComponent[],
  field: string,
): readonly PayrollAmountComponent[] {
  const result = values.map((item) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(item.code)) {
      invalid('PAYROLL_COMPONENT_CODE_INVALID', `${field} 项目编码非法`);
    }
    assertMinor(item.amountMinor, `${field}.${item.code}`);
    return Object.freeze({ code: item.code, amountMinor: item.amountMinor });
  }).sort((left, right) => left.code.localeCompare(right.code));
  if (new Set(result.map((item) => item.code)).size !== result.length) {
    invalid('PAYROLL_COMPONENT_DUPLICATE', `${field} 项目编码重复`);
  }
  return Object.freeze(result);
}

function assertMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('PAYROLL_AMOUNT_INVALID', `${field} 必须为非负安全整数分`);
  }
}

function sum(values: readonly number[]): number {
  return toSafeMinor(values.reduce((total, value) => total + BigInt(value), 0n));
}

function safeAdd(left: number, right: number): number {
  return toSafeMinor(BigInt(left) + BigInt(right));
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) invalid('PAYROLL_DIVISION_INVALID', '定点除法参数非法');
  return (numerator + denominator / 2n) / denominator;
}

function maxZero(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function toSafeMinor(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid('PAYROLL_AMOUNT_OVERFLOW', '金额超出安全整数范围');
  }
  return Number(value);
}

function toSafeSignedMinor(value: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < -limit || value > limit) {
    invalid('PAYROLL_AMOUNT_OVERFLOW', '金额超出安全整数范围');
  }
  return Number(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url');
}

function invalid(code: string, message: string): never {
  throw new PayrollCalculationError(code, message);
}
