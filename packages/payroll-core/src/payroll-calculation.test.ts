import { describe, expect, it } from 'vitest';

import { calculatePayrollLine, createMoneyMinor } from './index.js';

const input = {
  tenantId: 'tenant-001',
  employeeId: 'employee-001',
  period: '2026-07',
  ruleVersion: 1,
  components: [
    { code: 'base_salary', direction: 'earning' as const, amountMinor: '2000000', taxable: true },
    { code: 'allowance', direction: 'earning' as const, amountMinor: '100000', taxable: true },
    { code: 'absence', direction: 'deduction' as const, amountMinor: '5000', taxable: false },
  ],
  socialInsuranceEmployeeMinor: '210000',
  housingFundEmployeeMinor: '140000',
  specialDeductionMinor: '200000',
  withholdingTaxMinor: '35000',
};

describe('确定性算薪核心', () => {
  it('只接受整数分字符串', () => {
    expect(createMoneyMinor('1234')).toBe('1234');
    expect(() => createMoneyMinor('001')).toThrow('整数分');
    expect(() => createMoneyMinor('12.34')).toThrow('整数分');
  });

  it('相同输入生成相同金额和摘要', () => {
    const first = calculatePayrollLine(input);
    const second = calculatePayrollLine(input);
    expect(first).toEqual(second);
    expect(first.grossMinor).toBe('2100000');
    expect(first.totalDeductionMinor).toBe('390000');
    expect(first.netMinor).toBe('1710000');
    expect(first.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('拒绝重复工资项和负实发', () => {
    expect(() => calculatePayrollLine({
      ...input,
      components: [...input.components, input.components[0]!],
    })).toThrow('非法或重复');
    expect(() => calculatePayrollLine({
      ...input,
      withholdingTaxMinor: '3000000',
    })).toThrow('实发工资不得为负数');
  });
});
