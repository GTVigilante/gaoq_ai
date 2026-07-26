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

export interface PayrollCompensationAllocationEvidence {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileHash: string;
  readonly jurisdictionCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly allocatedFrom: string;
  readonly allocatedTo: string;
  readonly allocatedDays: number;
  readonly periodDays: number;
  readonly allocationMethod: 'CALENDAR_DAY_HALF_UP';
}

export interface PayrollCalculationInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly currency: 'CNY';
  readonly engineVersion: string;
  readonly rulePack: PayrollRulePackSnapshot;
  /** 新运行必须冻结规则法域；旧加密快照兼容读取时可缺省。 */
  readonly ruleJurisdictionCode?: string;
  readonly taxableEarnings: readonly PayrollAmountComponent[];
  readonly nonTaxableEarnings: readonly PayrollAmountComponent[];
  readonly employeeSocialInsuranceMinor: number;
  readonly employeeHousingFundMinor: number;
  /** 只减少计税基础，不从实发现金再次扣除。 */
  readonly specialAdditionalDeductionMinor: number;
  readonly otherPreTaxWithholdingMinor: number;
  readonly postTaxDeductionMinor: number;
  readonly cumulativeBefore: CumulativeWithholdingState;
  /** 月中变更时冻结档案、法域和分摊边界；旧整月快照可不包含。 */
  readonly compensationAllocations?: readonly PayrollCompensationAllocationEvidence[];
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
  readonly inputHash: string;
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
    ...(input.ruleJurisdictionCode === undefined ? {} : {
      ruleJurisdictionCode: input.ruleJurisdictionCode,
    }),
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
    ...(input.compensationAllocations === undefined ? {} : {
      compensationAllocations: Object.freeze(input.compensationAllocations
        .map((item) => Object.freeze({ ...item }))),
    }),
  });
  const inputDigest = payrollDigest(normalizedInput);
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
    inputHash: inputDigest,
    grossPayMinor: grossPay,
    taxableEarningsMinor: taxableEarnings,
    withholdingTaxMinor: toSafeSignedMinor(withholdingTax),
    netPayMinor: toSafeMinor(netPay),
    cumulativeAfter: Object.freeze({ ...cumulativeAfter }),
    steps,
  });
  return Object.freeze({ ...resultWithoutHash, resultHash: payrollDigest(resultWithoutHash) });
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
  if (input.ruleJurisdictionCode !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ruleJurisdictionCode)) {
    invalid('PAYROLL_RULE_JURISDICTION_INVALID', '工资规则法域非法');
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
  validateCompensationAllocations(input);
}

function validateCompensationAllocations(input: PayrollCalculationInput): void {
  if (input.compensationAllocations === undefined) return;
  if (input.ruleJurisdictionCode === undefined) {
    invalid('PAYROLL_RULE_JURISDICTION_REQUIRED', '月中分摊必须冻结工资规则法域');
  }
  if (input.compensationAllocations.length < 1 || input.compensationAllocations.length > 31) {
    invalid('PAYROLL_COMPENSATION_ALLOCATION_INVALID', '薪酬分摊证据数量非法');
  }
  const profileIds = new Set<string>();
  const periodDays = daysInPeriod(input.period);
  const periodEnd = `${input.period}-${String(periodDays).padStart(2, '0')}`;
  let expectedFrom = `${input.period}-01`;
  for (const allocation of input.compensationAllocations) {
    const effectiveFrom = calendarOrdinal(allocation.effectiveFrom);
    const effectiveTo = allocation.effectiveTo === null
      ? null
      : calendarOrdinal(allocation.effectiveTo);
    const allocatedFrom = calendarOrdinal(allocation.allocatedFrom);
    const allocatedTo = calendarOrdinal(allocation.allocatedTo);
    const actualAllocatedDays = allocatedFrom === null || allocatedTo === null
      ? 0
      : Math.round((allocatedTo - allocatedFrom) / 86_400_000) + 1;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(allocation.profileId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(allocation.jurisdictionCode) ||
      !/^[A-Za-z0-9_-]{43}$/.test(allocation.profileHash) ||
      !Number.isSafeInteger(allocation.profileVersion) || allocation.profileVersion < 1 ||
      !Number.isSafeInteger(allocation.allocatedDays) || allocation.allocatedDays < 1 ||
      !Number.isSafeInteger(allocation.periodDays) || allocation.periodDays < 28 ||
      allocation.periodDays > 31 ||
      allocation.allocationMethod !== 'CALENDAR_DAY_HALF_UP' ||
      effectiveFrom === null || allocatedFrom === null || allocatedTo === null ||
      allocatedFrom > allocatedTo ||
      (effectiveTo !== null && effectiveFrom > effectiveTo) ||
      allocation.allocatedFrom !== expectedFrom ||
      allocation.allocatedTo > periodEnd ||
      effectiveFrom > allocatedFrom ||
      (effectiveTo !== null && effectiveTo < allocatedTo) ||
      allocation.allocatedDays !== actualAllocatedDays ||
      allocation.periodDays !== periodDays ||
      !payrollRuleCoversJurisdiction(
        input.ruleJurisdictionCode,
        allocation.jurisdictionCode,
      ) ||
      profileIds.has(allocation.profileId)) {
      invalid('PAYROLL_COMPENSATION_ALLOCATION_INVALID', '薪酬分摊证据非法');
    }
    profileIds.add(allocation.profileId);
    expectedFrom = formatCalendarDate(allocatedTo + 86_400_000);
  }
  if (expectedFrom !== formatCalendarDate(
    requiredCalendarOrdinal(periodEnd) + 86_400_000,
  )) {
    invalid('PAYROLL_COMPENSATION_ALLOCATION_INVALID', '薪酬分摊区间未覆盖工资期间');
  }
}

/** 法域代码以短横线表达父子层级；例如 CN 规则可覆盖 CN-SH。 */
export function payrollRuleCoversJurisdiction(
  ruleJurisdictionCode: string,
  compensationJurisdictionCode: string,
): boolean {
  return compensationJurisdictionCode === ruleJurisdictionCode ||
    compensationJurisdictionCode.startsWith(`${ruleJurisdictionCode}-`);
}

function daysInPeriod(period: string): number {
  const [yearText, monthText] = period.split('-');
  return new Date(Date.UTC(Number(yearText), Number(monthText), 0)).getUTCDate();
}

function calendarOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && formatCalendarDate(parsed) === value ? parsed : null;
}

function requiredCalendarOrdinal(value: string): number {
  const parsed = calendarOrdinal(value);
  if (parsed === null) invalid('PAYROLL_COMPENSATION_ALLOCATION_INVALID', '工资期间日期非法');
  return parsed;
}

function formatCalendarDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
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

/** 工资证据统一规范摘要；对象键排序，数组保持业务顺序。 */
export function payrollDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalize(value, 0, new Set()), 'utf8')
    .digest('base64url');
}

function canonicalize(value: unknown, depth: number, seen: ReadonlySet<object>): string {
  if (depth > 20) invalid('PAYROLL_CANONICAL_VALUE_INVALID', '规范摘要嵌套深度超限');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid('PAYROLL_CANONICAL_VALUE_INVALID', '规范摘要只接受安全整数');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === undefined) {
    invalid('PAYROLL_CANONICAL_VALUE_INVALID', '规范摘要包含不支持的值');
  }
  if (seen.has(value)) invalid('PAYROLL_CANONICAL_VALUE_INVALID', '规范摘要包含循环引用');
  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, depth + 1, nextSeen)).join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('PAYROLL_CANONICAL_VALUE_INVALID', '规范摘要只接受纯对象');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalize(item, depth + 1, nextSeen)}`).join(',')}}`;
}

function invalid(code: string, message: string): never {
  throw new PayrollCalculationError(code, message);
}
