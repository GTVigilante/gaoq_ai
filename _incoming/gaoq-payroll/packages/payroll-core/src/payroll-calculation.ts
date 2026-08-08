import { createHash } from 'node:crypto';

const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/;

/** 领域内部和持久化边界统一使用的整数分字符串。 */
export type MoneyMinor = string;

/** 工资组成项输入。 */
export interface PayrollComponentInput {
  readonly code: string;
  readonly direction: 'earning' | 'deduction';
  readonly amountMinor: MoneyMinor;
  readonly taxable: boolean;
}

/** 单员工确定性算薪输入快照。 */
export interface PayrollLineInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly ruleVersion: number;
  readonly components: readonly PayrollComponentInput[];
  readonly socialInsuranceEmployeeMinor: MoneyMinor;
  readonly housingFundEmployeeMinor: MoneyMinor;
  readonly specialDeductionMinor: MoneyMinor;
  readonly withholdingTaxMinor: MoneyMinor;
}

/** 单员工确定性算薪结果。 */
export interface PayrollLineResult {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly period: string;
  readonly ruleVersion: number;
  readonly grossMinor: MoneyMinor;
  readonly taxableIncomeMinor: MoneyMinor;
  readonly totalDeductionMinor: MoneyMinor;
  readonly withholdingTaxMinor: MoneyMinor;
  readonly netMinor: MoneyMinor;
  readonly resultDigest: string;
}

/** 校验并规范化整数分，禁止小数或 JavaScript 浮点进入领域层。 */
export const createMoneyMinor = (value: string): MoneyMinor => {
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error('金额必须为十进制整数分字符串');
  }
  return BigInt(value).toString();
};

const toMinor = (value: MoneyMinor): bigint => BigInt(createMoneyMinor(value));

/** 按稳定字段顺序生成工资行摘要。 */
export const payrollLineDigest = (
  value: Omit<PayrollLineResult, 'resultDigest'>,
): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * 计算单员工工资行。
 *
 * 输入必须是已冻结的工资组成、法定扣除与预扣税快照；本函数不访问数据库、
 * 当前时间或外部服务，因此同一输入始终产生同一结果。
 */
export const calculatePayrollLine = (input: PayrollLineInput): PayrollLineResult => {
  if (input.tenantId.length === 0 || input.employeeId.length === 0) {
    throw new Error('租户和员工标识不能为空');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new Error('工资周期必须使用 YYYY-MM');
  }
  if (!Number.isInteger(input.ruleVersion) || input.ruleVersion < 1) {
    throw new Error('规则版本必须为正整数');
  }
  const codes = new Set<string>();
  let gross = 0n;
  let componentDeduction = 0n;
  let taxableEarning = 0n;
  for (const component of input.components) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(component.code) || codes.has(component.code)) {
      throw new Error('工资组成项编码非法或重复');
    }
    codes.add(component.code);
    const amount = toMinor(component.amountMinor);
    if (amount < 0n) throw new Error('工资组成项金额不得为负数');
    if (component.direction === 'earning') {
      gross += amount;
      if (component.taxable) taxableEarning += amount;
    } else {
      componentDeduction += amount;
    }
  }
  const socialInsurance = toMinor(input.socialInsuranceEmployeeMinor);
  const housingFund = toMinor(input.housingFundEmployeeMinor);
  const specialDeduction = toMinor(input.specialDeductionMinor);
  const tax = toMinor(input.withholdingTaxMinor);
  if ([socialInsurance, housingFund, specialDeduction, tax].some((value) => value < 0n)) {
    throw new Error('法定扣除和预扣税不得为负数');
  }
  const taxableIncome = taxableEarning - socialInsurance - housingFund - specialDeduction;
  const totalDeduction = componentDeduction + socialInsurance + housingFund + tax;
  const net = gross - totalDeduction;
  if (net < 0n) throw new Error('实发工资不得为负数');
  const withoutDigest = {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    period: input.period,
    ruleVersion: input.ruleVersion,
    grossMinor: gross.toString(),
    taxableIncomeMinor: (taxableIncome > 0n ? taxableIncome : 0n).toString(),
    totalDeductionMinor: totalDeduction.toString(),
    withholdingTaxMinor: tax.toString(),
    netMinor: net.toString(),
  };
  return Object.freeze({
    ...withoutDigest,
    resultDigest: payrollLineDigest(withoutDigest),
  });
};
