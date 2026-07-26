import { describe, expect, it } from 'vitest';

import {
  calculatePayroll,
  payrollDigest,
  type PayrollCalculationInput,
} from './payroll-calculation.js';

const base: PayrollCalculationInput = {
  tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: 'cn-tax-2026-shanghai', version: 1, monthlyBasicDeductionMinor: 500_000,
    roundingMode: 'HALF_UP',
    taxBrackets: [
      { upperBoundMinor: 3_600_000, rateBps: 300, quickDeductionMinor: 0 },
      { upperBoundMinor: 14_400_000, rateBps: 1_000, quickDeductionMinor: 252_000 },
      { upperBoundMinor: null, rateBps: 2_000, quickDeductionMinor: 1_692_000 },
    ],
  },
  taxableEarnings: [{ code: 'BASE_SALARY', amountMinor: 1_000_000 }],
  nonTaxableEarnings: [],
  employeeSocialInsuranceMinor: 100_000,
  employeeHousingFundMinor: 50_000,
  specialAdditionalDeductionMinor: 0,
  otherPreTaxWithholdingMinor: 0,
  postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};

describe('累计预扣确定性计算内核', () => {
  it('只用整数分和基点计算首月应税、预扣与实发', () => {
    const result = calculatePayroll(base);
    expect(result).toMatchObject({
      grossPayMinor: 1_000_000, taxableEarningsMinor: 1_000_000,
      withholdingTaxMinor: 10_500, netPayMinor: 839_500,
      cumulativeAfter: {
        taxableIncomeMinor: 1_000_000, basicDeductionMinor: 500_000,
        socialInsuranceMinor: 100_000, housingFundMinor: 50_000,
        taxWithheldMinor: 10_500,
      },
    });
    expect(result.steps).toHaveLength(5);
    expect(result.inputHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.resultHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('跨税率档时按累计税额减累计已扣税，不重复征税', () => {
    const result = calculatePayroll({
      ...base,
      cumulativeBefore: {
        taxableIncomeMinor: 4_000_000, basicDeductionMinor: 500_000,
        socialInsuranceMinor: 0, housingFundMinor: 0,
        specialAdditionalDeductionMinor: 0, otherDeductionMinor: 0,
        taxWithheldMinor: 105_000,
      },
    });
    expect(result.steps.find((step) => step.code === 'cumulative_taxable_income')?.amountMinor)
      .toBe(3_850_000);
    expect(result.withholdingTaxMinor).toBe(28_000);
    expect(result.netPayMinor).toBe(822_000);
    expect(result.cumulativeAfter.taxWithheldMinor).toBe(133_000);
  });

  it('项目输入顺序不影响步骤或结果哈希', () => {
    const left = calculatePayroll({
      ...base,
      taxableEarnings: [
        { code: 'BONUS', amountMinor: 200_000 },
        { code: 'BASE_SALARY', amountMinor: 800_000 },
      ],
    });
    const right = calculatePayroll({
      ...base,
      taxableEarnings: [
        { code: 'BASE_SALARY', amountMinor: 800_000 },
        { code: 'BONUS', amountMinor: 200_000 },
      ],
    });
    expect(right.resultHash).toBe(left.resultHash);
    expect(right.steps).toEqual(left.steps);
  });

  it('规范摘要对对象键顺序稳定，并拒绝日期对象和循环引用', () => {
    expect(payrollDigest({ amount: 1, code: 'BASE' }))
      .toBe(payrollDigest({ code: 'BASE', amount: 1 }));
    expect(() => payrollDigest(new Date('2026-01-01T00:00:00.000Z')))
      .toThrow(/纯对象/u);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => payrollDigest(cyclic)).toThrow(/循环引用/u);
  });

  it('累计已扣税高于当前累计税额时形成负税额调整并增加实发', () => {
    const result = calculatePayroll({
      ...base,
      cumulativeBefore: { ...base.cumulativeBefore, taxWithheldMinor: 20_000 },
    });
    expect(result.withholdingTaxMinor).toBe(-9_500);
    expect(result.netPayMinor).toBe(859_500);
    expect(result.cumulativeAfter.taxWithheldMinor).toBe(10_500);
  });

  it('拒绝浮点金额、重复项目、税率表缺口和负实发', () => {
    expect(() => calculatePayroll({
      ...base, employeeSocialInsuranceMinor: 1.5,
    })).toThrow(/安全整数分/u);
    expect(() => calculatePayroll({
      ...base,
      taxableEarnings: [
        { code: 'BASE_SALARY', amountMinor: 1 },
        { code: 'BASE_SALARY', amountMinor: 2 },
      ],
    })).toThrow(/重复/u);
    expect(() => calculatePayroll({
      ...base, rulePack: { ...base.rulePack, taxBrackets: base.rulePack.taxBrackets.slice(0, 1) },
    })).toThrow(/无上限档/u);
    expect(() => calculatePayroll({
      ...base, postTaxDeductionMinor: 900_000,
    })).toThrow(/实发金额不能为负/u);
  });

  it('月中分摊证据必须连续覆盖整月、落在档案有效期且匹配规则法域', () => {
    const allocations = [
      {
        profileId: 'profile-001', profileVersion: 1, profileHash: 'a'.repeat(43),
        jurisdictionCode: 'CN-SH', effectiveFrom: '2026-01-01',
        effectiveTo: '2026-07-15', allocatedFrom: '2026-07-01',
        allocatedTo: '2026-07-15', allocatedDays: 15, periodDays: 31,
        allocationMethod: 'CALENDAR_DAY_HALF_UP' as const,
      },
      {
        profileId: 'profile-002', profileVersion: 2, profileHash: 'b'.repeat(43),
        jurisdictionCode: 'CN-BJ', effectiveFrom: '2026-07-16',
        effectiveTo: null, allocatedFrom: '2026-07-16',
        allocatedTo: '2026-07-31', allocatedDays: 16, periodDays: 31,
        allocationMethod: 'CALENDAR_DAY_HALF_UP' as const,
      },
    ] as const;
    expect(calculatePayroll({
      ...base,
      ruleJurisdictionCode: 'CN',
      compensationAllocations: allocations,
    }).inputHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => calculatePayroll({
      ...base,
      ruleJurisdictionCode: 'US',
      compensationAllocations: allocations,
    })).toThrow(/薪酬分摊证据非法/u);
    expect(() => calculatePayroll({
      ...base,
      ruleJurisdictionCode: 'CN',
      compensationAllocations: [
        allocations[0],
        { ...allocations[1], allocatedFrom: '2026-07-17', allocatedDays: 15 },
      ],
    })).toThrow(/薪酬分摊证据非法/u);
    expect(() => calculatePayroll({
      ...base,
      ruleJurisdictionCode: 'CN',
      compensationAllocations: [
        { ...allocations[0], effectiveTo: '2026-07-14' },
        allocations[1],
      ],
    })).toThrow(/薪酬分摊证据非法/u);
  });
});
