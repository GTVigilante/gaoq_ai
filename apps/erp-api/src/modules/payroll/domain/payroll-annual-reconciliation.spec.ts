import { describe, expect, it } from 'vitest';

import {
  calculatePayroll,
  reconcileAnnualPayrollWithholding,
  type AnnualPayrollWithholdingEntry,
  type PayrollCalculationInput,
} from './index.js';

const january: PayrollCalculationInput = {
  tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-01',
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
const januaryResult = calculatePayroll(january);
const february: PayrollCalculationInput = {
  ...january, period: '2026-02', cumulativeBefore: januaryResult.cumulativeAfter,
};
const februaryResult = calculatePayroll(february);

function entry(
  period: string,
  input: PayrollCalculationInput,
  filedWithholdingTaxMinor: number,
): AnnualPayrollWithholdingEntry {
  const result = calculatePayroll(input);
  return {
    period, input, result,
    filingId: `filing-${period}`,
    filingEvidenceId: `tax-evidence-${period}`,
    filingStatus: 'submitted',
    filedWithholdingTaxMinor,
  };
}

describe('年度工资代扣与税局评估核对', () => {
  it('逐月申报守恒但尚无税局年度评估时保持等待状态', () => {
    const result = reconcileAnnualPayrollWithholding({
      tenantId: 'tenant-001', employeeId: 'employee-001', taxYear: '2026',
      entries: [
        entry('2026-01', january, januaryResult.withholdingTaxMinor),
        entry('2026-02', february, februaryResult.withholdingTaxMinor),
      ],
    });
    expect(result).toMatchObject({
      periodCount: 2, totalTaxableEarningsMinor: 2_000_000,
      totalPayrollWithheldMinor: 21_000, totalFiledWithholdingMinor: 21_000,
      cumulativeTaxLiabilityMinor: 21_000, status: 'awaiting_assessment',
      employeePayableToTaxAuthorityMinor: 0, employeeRefundFromTaxAuthorityMinor: 0,
      differences: [],
    });
  });

  it('税局评估低于工资已扣税时仅形成员工应退提示，不自动退款', () => {
    const result = reconcileAnnualPayrollWithholding({
      tenantId: 'tenant-001', employeeId: 'employee-001', taxYear: '2026',
      entries: [
        entry('2026-01', january, januaryResult.withholdingTaxMinor),
        entry('2026-02', february, februaryResult.withholdingTaxMinor),
      ],
      officialAssessment: {
        assessmentId: 'assessment-2026',
        assessmentEvidenceId: 'assessment-evidence-2026',
        assessedTaxMinor: 20_000, sourceDigest: 's'.repeat(43),
      },
    });
    expect(result).toMatchObject({
      officialAssessedTaxMinor: 20_000,
      employeeRefundFromTaxAuthorityMinor: 1_000,
      employeePayableToTaxAuthorityMinor: 0,
      status: 'requires_employee_settlement',
    });
  });

  it('月度申报金额不等于冻结工资时冻结年度核对', () => {
    const result = reconcileAnnualPayrollWithholding({
      tenantId: 'tenant-001', employeeId: 'employee-001', taxYear: '2026',
      entries: [
        entry('2026-01', january, januaryResult.withholdingTaxMinor + 1),
        entry('2026-02', february, februaryResult.withholdingTaxMinor),
      ],
    });
    expect(result.status).toBe('frozen');
    expect(result.differences).toEqual([
      'ANNUAL_FILING_TOTAL_MISMATCH', 'MONTHLY_FILING_MISMATCH',
    ]);
  });

  it('累计预扣状态链断裂时失败关闭', () => {
    expect(() => reconcileAnnualPayrollWithholding({
      tenantId: 'tenant-001', employeeId: 'employee-001', taxYear: '2026',
      entries: [
        entry('2026-01', january, januaryResult.withholdingTaxMinor),
        entry('2026-02', {
          ...february,
          cumulativeBefore: { ...february.cumulativeBefore, taxWithheldMinor: 0 },
        }, februaryResult.withholdingTaxMinor),
      ],
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ANNUAL_CUMULATIVE_CHAIN_BROKEN',
    }));
  });
});
