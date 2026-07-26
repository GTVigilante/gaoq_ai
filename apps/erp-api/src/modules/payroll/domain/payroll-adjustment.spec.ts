import { describe, expect, it } from 'vitest';

import {
  calculatePayroll,
  createPayrollAdjustment,
  type PayrollCalculationInput,
} from './index.js';

const base: PayrollCalculationInput = {
  tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: 'rule-001', version: 1, monthlyBasicDeductionMinor: 500_000,
    roundingMode: 'HALF_UP',
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
  nonTaxableEarnings: [], employeeSocialInsuranceMinor: 100_000,
  employeeHousingFundMinor: 50_000, specialAdditionalDeductionMinor: 0,
  otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};

function adjust(corrected: PayrollCalculationInput) {
  return createPayrollAdjustment({
    tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
    originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
    reasonCode: 'RETROACTIVE_SALARY_CHANGE', originalPeriodStatus: 'reconciled',
    original: calculatePayroll(base), corrected: calculatePayroll(corrected),
  });
}

describe('锁定工资补发与冲销差额', () => {
  it('正向净额只形成补发应付，不接受任意客户端金额', () => {
    const result = adjust({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
    });
    expect(result).toMatchObject({
      type: 'supplement', payableMinor: 97_000, receivableMinor: 0,
      delta: {
        grossPayMinor: 100_000, taxableEarningsMinor: 100_000,
        withholdingTaxMinor: 3_000, netPayMinor: 97_000,
      },
    });
    expect(result.adjustmentHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('负向净额形成独立应收，绝不生成负数银行支付', () => {
    const result = adjust({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 900_000 }],
    });
    expect(result).toMatchObject({
      type: 'reversal', payableMinor: 0, receivableMinor: 97_000,
      delta: { netPayMinor: -97_000 },
    });
  });

  it('相同规范输入或被篡改原结果均失败关闭', () => {
    expect(() => adjust(base)).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_INPUT_UNCHANGED',
    }));
    const original = calculatePayroll(base);
    expect(() => createPayrollAdjustment({
      tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
      originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE', originalPeriodStatus: 'locked',
      original: { ...original, netPayMinor: original.netPayMinor + 1 },
      corrected: calculatePayroll({
        ...base, taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
      }),
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_ORIGINAL_INTEGRITY_FAILED',
    }));
  });
});
