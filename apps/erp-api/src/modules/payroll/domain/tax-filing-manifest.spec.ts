import { describe, expect, it } from 'vitest';

import {
  generateTaxFilingManifest,
  TaxFilingManifestError,
  type TaxFilingManifestLine,
} from './tax-filing-manifest.js';

const line = (employeeId: string, suffix: string): TaxFilingManifestLine => ({
  employeeId, calculationLineId: `01J8ZQK7V0A2M4N6P8R0T2W4${suffix}`,
  identityEvidenceId: `identity-evidence-${suffix}`,
  taxableEarningsMinor: 1_000_000, withholdingTaxMinor: 10_500,
  cumulativeTaxableIncomeMinor: 4_000_000, cumulativeTaxWithheldMinor: 133_000,
  resultHash: (suffix[0] ?? 'a').toLowerCase().repeat(43),
});

const input = (lines: readonly TaxFilingManifestLine[]) => ({
  filingId: '01J8ZQK7V0A2M4N6P8R0T2W4F0', tenantId: 'tenant-001', period: '2026-07',
  payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R0', payrollResultHash: 'p'.repeat(43), lines,
});

describe('个税内部规范清单', () => {
  it('按员工确定性排序并使用整数安全汇总', () => {
    const generated = generateTaxFilingManifest(input([
      line('employee-002', 'B2'), line('employee-001', 'A1'),
    ]));
    const replay = generateTaxFilingManifest(input([
      line('employee-001', 'A1'), line('employee-002', 'B2'),
    ]));
    expect(generated).toEqual(replay);
    expect(generated).toMatchObject({
      format: 'CN_IIT_WITHHOLDING_MANIFEST_V1', employeeCount: 2,
      totalTaxableEarningsMinor: 2_000_000, totalWithholdingTaxMinor: 21_000,
    });
    expect(generated.content.indexOf('employee-001'))
      .toBeLessThan(generated.content.indexOf('employee-002'));
    expect(generated.contentHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('允许受控退税负数但拒绝重复身份凭证和非安全整数', () => {
    const refund = generateTaxFilingManifest(input([
      { ...line('employee-001', 'A1'), withholdingTaxMinor: -500 },
    ]));
    expect(refund.totalWithholdingTaxMinor).toBe(-500);
    expect(() => generateTaxFilingManifest(input([
      line('employee-001', 'A1'), { ...line('employee-002', 'B2'), identityEvidenceId: 'identity-evidence-A1' },
    ]))).toThrow(TaxFilingManifestError);
    expect(() => generateTaxFilingManifest(input([
      { ...line('employee-001', 'A1'), taxableEarningsMinor: Number.MAX_SAFE_INTEGER + 1 },
    ]))).toThrow('税务清单员工行非法');
  });
});
