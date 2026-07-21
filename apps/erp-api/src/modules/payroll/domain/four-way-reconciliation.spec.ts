import { describe, expect, it } from 'vitest';

import {
  FourWayReconciliationError,
  reconcilePayrollFourWay,
  type FourWayReconciliationInput,
} from './four-way-reconciliation.js';

const input = (): FourWayReconciliationInput => ({
  tenantId: 'tenant-001',
  payroll: {
    periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1', payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
    resultHash: 'a'.repeat(43), employeeCount: 2, totalGrossMinor: 2_000_000,
    totalNetMinor: 1_679_000, totalWithholdingTaxMinor: 21_000,
  },
  disbursement: {
    batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
    payrollPeriodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
    status: 'reconciling', lineCount: 2, totalMinor: 1_679_000,
    bankSubmissionId: 'bank-submission-001', bankSubmissionEvidenceId: 'bank-evidence-001',
  },
  bankReturn: {
    returnId: '01J8ZQK7V0A2M4N6P8R0T2W4N1', batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
    returnHash: 'b'.repeat(43), outcome: 'accepted', successfulCount: 2,
    successfulMinor: 1_679_000, failedCount: 0, failedMinor: 0,
  },
  taxFiling: {
    filingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
    status: 'submitted', employeeCount: 2, totalTaxableEarningsMinor: 2_000_000,
    totalWithholdingTaxMinor: 21_000, contentHash: 'c'.repeat(43),
    taxSubmissionId: 'tax-submission-001', taxSubmissionEvidenceId: 'tax-evidence-001',
  },
});

describe('工资四方对账领域核验', () => {
  it('工资净额、银行提交/回盘与个税控制量全部守恒', () => {
    const result = reconcilePayrollFourWay(input());
    expect(result).toMatchObject({
      balanced: true, differences: [], employeeCount: 2, bankLineCount: 2,
      totalNetMinor: 1_679_000, bankSubmittedMinor: 1_679_000,
      bankReturnedMinor: 1_679_000, payrollWithholdingTaxMinor: 21_000,
      filedWithholdingTaxMinor: 21_000,
    });
    expect(result.evidenceHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(reconcilePayrollFourWay(input()).evidenceHash).toBe(result.evidenceHash);
  });

  it('逐项列出金额、人数和回盘差异且不误判应发等于实发', () => {
    const current = input();
    const result = reconcilePayrollFourWay({
      ...current,
      disbursement: { ...current.disbursement, totalMinor: 1_670_000, lineCount: 1 },
      taxFiling: {
        ...current.taxFiling, employeeCount: 1, totalWithholdingTaxMinor: 20_000,
      },
    });
    expect(result.balanced).toBe(false);
    expect(result.differences).toEqual([
      'PAYROLL_BANK_AMOUNT_MISMATCH', 'BANK_RETURN_AMOUNT_MISMATCH',
      'BANK_RETURN_COUNT_MISMATCH', 'PAYROLL_TAX_AMOUNT_MISMATCH',
      'PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH',
    ]);
    expect(result.totalGrossMinor).not.toBe(result.totalNetMinor);
  });

  it('错工资运行、错批次和不安全整数失败关闭', () => {
    const current = input();
    expect(() => reconcilePayrollFourWay({
      ...current,
      taxFiling: { ...current.taxFiling, payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R2' },
    })).toThrow(FourWayReconciliationError);
    expect(() => reconcilePayrollFourWay({
      ...current,
      payroll: { ...current.payroll, totalNetMinor: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow('四方对账引用或控制量非法');
  });
});
