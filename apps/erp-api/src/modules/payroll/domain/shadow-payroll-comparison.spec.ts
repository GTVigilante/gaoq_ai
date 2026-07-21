import { describe, expect, it } from 'vitest';

import {
  compareShadowPayroll,
  ShadowPayrollComparisonError,
  shadowPayrollManifestHash,
  type LegacyShadowPayrollLine,
  type ShadowPayrollLine,
} from './shadow-payroll-comparison.js';
import { payrollDigest } from './payroll-calculation.js';

const erpLines: readonly ShadowPayrollLine[] = [
  { employeeId: 'employee-001', grossPayMinor: 100_000, withholdingTaxMinor: 1_000,
    netPayMinor: 90_000, resultHash: 'a'.repeat(43) },
  { employeeId: 'employee-002', grossPayMinor: 200_000, withholdingTaxMinor: 2_000,
    netPayMinor: 180_000, resultHash: 'b'.repeat(43) },
];
const legacyLines: readonly LegacyShadowPayrollLine[] = erpLines.map((line, index) => ({
  ...line, sourceLineId: `legacy-line-${index + 1}`,
}));

function input(lines = legacyLines) {
  return {
    period: '2026-07', payrollRunId: 'payroll-run-001',
    payrollResultHash: payrollDigest(erpLines.map((line) => ({
      employeeId: line.employeeId, resultHash: line.resultHash,
    }))),
    sourceSystem: 'legacy-payroll', sourceExportId: 'legacy-export-001',
    sourceObjectEvidenceId: 'legacy-worm-001', sourceSignatureEvidenceId: 'legacy-signature-001',
    sourceManifestHash: shadowPayrollManifestHash({
      period: '2026-07', sourceSystem: 'legacy-payroll',
      sourceExportId: 'legacy-export-001', lines,
    }),
    erpLines, legacyLines: lines,
  } as const;
}

describe('工资影子比较', () => {
  it('逐行完全一致时形成零差异确定性证据', () => {
    const result = compareShadowPayroll(input());
    expect(result.differences).toEqual([]);
    expect(result.totalAbsoluteDifferenceMinor).toBe(0);
    expect(result.erpTotalNetMinor).toBe(270_000);
    expect(result.comparisonHash).toHaveLength(43);
  });

  it('精确识别人员缺失与各金额字段差异，不使用容差', () => {
    const lines: readonly LegacyShadowPayrollLine[] = [
      { ...legacyLines[0]!, grossPayMinor: 100_001, withholdingTaxMinor: 999,
        netPayMinor: 90_001 },
      { employeeId: 'employee-003', sourceLineId: 'legacy-line-3', grossPayMinor: 50_000,
        withholdingTaxMinor: 0, netPayMinor: 50_000, resultHash: 'c'.repeat(43) },
    ];
    const result = compareShadowPayroll(input(lines));
    expect(result.differenceCodes).toEqual([
      'ERP_EMPLOYEE_MISSING', 'GROSS_AMOUNT_MISMATCH', 'LEGACY_EMPLOYEE_MISSING',
      'NET_AMOUNT_MISMATCH', 'WITHHOLDING_TAX_MISMATCH',
    ]);
    expect(result.differences).toHaveLength(5);
    expect(result.totalAbsoluteDifferenceMinor).toBe(230_003);
  });

  it('拒绝篡改来源摘要、ERP 摘要和重复员工', () => {
    expect(() => compareShadowPayroll({ ...input(), sourceManifestHash: 'z'.repeat(43) }))
      .toThrow(ShadowPayrollComparisonError);
    expect(() => compareShadowPayroll({ ...input(), payrollResultHash: 'z'.repeat(43) }))
      .toThrow('ERP 工资结果摘要不一致');
    expect(() => shadowPayrollManifestHash({
      period: '2026-07', sourceSystem: 'legacy-payroll', sourceExportId: 'legacy-export-001',
      lines: [legacyLines[0]!, legacyLines[0]!],
    })).toThrow('员工唯一性非法');
  });
});
