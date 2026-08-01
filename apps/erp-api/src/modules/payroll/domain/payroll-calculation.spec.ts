import { describe, expect, it } from 'vitest';

import {
  calculatePayroll,
  payrollDigest,
  type PayrollCalculationError,
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
const firstAllocation = {
  profileId: 'profile-001',
  profileVersion: 1,
  profileHash: 'a'.repeat(43),
  jurisdictionCode: 'CN-SH',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-07-15',
  allocatedFrom: '2026-07-01',
  allocatedTo: '2026-07-15',
  allocatedDays: 15,
  periodDays: 31,
  allocationMethod: 'CALENDAR_DAY_HALF_UP',
} as const;
const secondAllocation = {
  ...firstAllocation,
  profileId: 'profile-002',
  profileVersion: 2,
  profileHash: 'b'.repeat(43),
  jurisdictionCode: 'CN-BJ',
  effectiveFrom: '2026-07-16',
  effectiveTo: null,
  allocatedFrom: '2026-07-16',
  allocatedTo: '2026-07-31',
  allocatedDays: 16,
} as const;

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

  it('月中跨法域薪酬分摊证据进入输入摘要且完整覆盖自然日', () => {
    const withAllocations = calculatePayroll({
      ...base,
      compensationAllocations: [firstAllocation, secondAllocation],
    });
    const withoutAllocations = calculatePayroll(base);

    expect(withAllocations.inputHash).not.toBe(withoutAllocations.inputHash);
    expect(withAllocations.resultHash).not.toBe(withoutAllocations.resultHash);
    expect(withAllocations.netPayMinor).toBe(withoutAllocations.netPayMinor);
  });

  it('薪酬分摊证据对引用、日期、法域、天数、方法和重复档案逐项失败关闭', () => {
    const invalidAllocations = [
      [],
      [{ ...firstAllocation, profileId: '@' }, secondAllocation],
      [{ ...firstAllocation, jurisdictionCode: '@' }, secondAllocation],
      [{ ...firstAllocation, profileHash: 'short' }, secondAllocation],
      [{ ...firstAllocation, profileVersion: 0 }, secondAllocation],
      [{ ...firstAllocation, allocatedDays: 0 }, secondAllocation],
      [{ ...firstAllocation, periodDays: 27 }, secondAllocation],
      [{ ...firstAllocation, periodDays: 32 }, secondAllocation],
      [{
        ...firstAllocation,
        allocationMethod: 'WORKING_DAY' as never,
      }, secondAllocation],
      [{ ...firstAllocation, effectiveFrom: '2026-7-01' }, secondAllocation],
      [{ ...firstAllocation, effectiveTo: '2026-7-15' }, secondAllocation],
      [{ ...firstAllocation, allocatedFrom: '2026-7-01' }, secondAllocation],
      [{ ...firstAllocation, allocatedTo: '2026-7-15' }, secondAllocation],
      [{
        ...firstAllocation,
        allocatedFrom: '2026-07-16',
        allocatedTo: '2026-07-15',
      }, secondAllocation],
      [{ ...firstAllocation, periodDays: 30 }, secondAllocation],
      [firstAllocation, { ...secondAllocation, profileId: firstAllocation.profileId }],
      [firstAllocation, { ...secondAllocation, allocatedDays: 15 }],
    ] as const;

    for (const compensationAllocations of invalidAllocations) {
      expect(() => calculatePayroll({
        ...base,
        compensationAllocations,
      })).toThrow(expect.objectContaining<Partial<PayrollCalculationError>>({
        code: 'PAYROLL_COMPENSATION_ALLOCATION_INVALID',
      }));
    }
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

  it('规范摘要覆盖所有允许类型并拒绝越界、深层及不可序列化值', () => {
    expect(payrollDigest({
      array: [null, true, 'text', 1],
      nullable: null,
      omitted: undefined,
    })).toBe(payrollDigest({
      nullable: null,
      array: [null, true, 'text', 1],
    }));
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.safe = 1;
    expect(payrollDigest(nullPrototype)).toHaveLength(43);
    expect(() => payrollDigest(Number.MAX_SAFE_INTEGER + 1))
      .toThrow('规范摘要只接受安全整数');
    expect(() => payrollDigest(undefined)).toThrow('包含不支持的值');
    expect(() => payrollDigest(Symbol('invalid'))).toThrow('包含不支持的值');
    let deep: unknown = 'leaf';
    for (let index = 0; index < 22; index += 1) deep = [deep];
    expect(() => payrollDigest(deep)).toThrow('嵌套深度超限');
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

  it('对标识、税率连续性、组件和金额边界逐项失败关闭', () => {
    const invalidCases: readonly [
      PayrollCalculationInput,
      string,
    ][] = [
      [{ ...base, tenantId: '@' }, 'PAYROLL_IDENTIFIER_INVALID'],
      [{ ...base, period: '2026-13' }, 'PAYROLL_PERIOD_INVALID'],
      [{ ...base, rulePack: { ...base.rulePack, version: 0 } }, 'PAYROLL_RULE_VERSION_INVALID'],
      [{ ...base, employeeHousingFundMinor: -1 }, 'PAYROLL_AMOUNT_INVALID'],
      [{
        ...base,
        rulePack: { ...base.rulePack, roundingMode: 'BANKERS' as never },
      }, 'PAYROLL_ROUNDING_MODE_UNSUPPORTED'],
      [{
        ...base,
        rulePack: { ...base.rulePack, taxBrackets: [] },
      }, 'PAYROLL_TAX_BRACKETS_INVALID'],
      [{
        ...base,
        rulePack: {
          ...base.rulePack,
          taxBrackets: [{ upperBoundMinor: null, rateBps: 10_001, quickDeductionMinor: 0 }],
        },
      }, 'PAYROLL_TAX_RATE_INVALID'],
      [{
        ...base,
        rulePack: {
          ...base.rulePack,
          taxBrackets: [
            { upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 },
            { upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 },
          ],
        },
      }, 'PAYROLL_TAX_BRACKETS_INVALID'],
      [{
        ...base,
        rulePack: {
          ...base.rulePack,
          taxBrackets: [
            { upperBoundMinor: 100, rateBps: 300, quickDeductionMinor: 0 },
            { upperBoundMinor: 100, rateBps: 300, quickDeductionMinor: 0 },
            { upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 },
          ],
        },
      }, 'PAYROLL_TAX_BRACKETS_INVALID'],
      [{
        ...base,
        rulePack: {
          ...base.rulePack,
          taxBrackets: [
            { upperBoundMinor: 100, rateBps: 300, quickDeductionMinor: 0 },
            { upperBoundMinor: null, rateBps: 200, quickDeductionMinor: 0 },
          ],
        },
      }, 'PAYROLL_TAX_BRACKETS_INVALID'],
      [{
        ...base,
        rulePack: {
          ...base.rulePack,
          taxBrackets: [
            { upperBoundMinor: 100, rateBps: 300, quickDeductionMinor: 0 },
            { upperBoundMinor: null, rateBps: 1_000, quickDeductionMinor: 0 },
          ],
        },
      }, 'PAYROLL_TAX_BRACKETS_INVALID'],
      [{
        ...base,
        taxableEarnings: [{ code: 'bad-code', amountMinor: 1 }],
      }, 'PAYROLL_COMPONENT_CODE_INVALID'],
      [{
        ...base,
        taxableEarnings: [{ code: 'BASE', amountMinor: -1 }],
      }, 'PAYROLL_AMOUNT_INVALID'],
      [{
        ...base,
        taxableEarnings: [
          { code: 'BASE', amountMinor: Number.MAX_SAFE_INTEGER },
          { code: 'BONUS', amountMinor: 1 },
        ],
      }, 'PAYROLL_AMOUNT_OVERFLOW'],
      [{
        ...base,
        cumulativeBefore: {
          ...base.cumulativeBefore,
          taxableIncomeMinor: Number.MAX_SAFE_INTEGER,
        },
      }, 'PAYROLL_AMOUNT_OVERFLOW'],
    ];
    for (const [input, code] of invalidCases) {
      expect(() => calculatePayroll(input)).toThrow(
        expect.objectContaining<Partial<PayrollCalculationError>>({ code }),
      );
    }
  });
});
