import { payrollDigest } from './payroll-calculation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_LINES = 5_000;

export type ShadowPayrollDifferenceCode =
  | 'LEGACY_EMPLOYEE_MISSING'
  | 'ERP_EMPLOYEE_MISSING'
  | 'GROSS_AMOUNT_MISMATCH'
  | 'WITHHOLDING_TAX_MISMATCH'
  | 'NET_AMOUNT_MISMATCH';

export interface ShadowPayrollLine {
  readonly employeeId: string;
  readonly grossPayMinor: number;
  readonly withholdingTaxMinor: number;
  readonly netPayMinor: number;
  readonly resultHash: string;
}

export interface LegacyShadowPayrollLine extends ShadowPayrollLine {
  readonly sourceLineId: string;
}

export interface ShadowPayrollDifference {
  readonly employeeId: string;
  readonly code: ShadowPayrollDifferenceCode;
  readonly erpMinor: number | null;
  readonly legacyMinor: number | null;
  readonly deltaMinor: number | null;
  readonly evidenceHash: string;
}

export interface ShadowPayrollComparisonInput {
  readonly period: string;
  readonly payrollRunId: string;
  readonly payrollResultHash: string;
  readonly sourceSystem: string;
  readonly sourceExportId: string;
  readonly sourceObjectEvidenceId: string;
  readonly sourceSignatureEvidenceId: string;
  readonly sourceManifestHash: string;
  readonly erpLines: readonly ShadowPayrollLine[];
  readonly legacyLines: readonly LegacyShadowPayrollLine[];
}

export interface ShadowPayrollComparisonResult {
  readonly comparisonHash: string;
  readonly differenceCodes: readonly ShadowPayrollDifferenceCode[];
  readonly differences: readonly ShadowPayrollDifference[];
  readonly erpEmployeeCount: number;
  readonly legacyEmployeeCount: number;
  readonly erpTotalGrossMinor: number;
  readonly legacyTotalGrossMinor: number;
  readonly erpTotalTaxMinor: number;
  readonly legacyTotalTaxMinor: number;
  readonly erpTotalNetMinor: number;
  readonly legacyTotalNetMinor: number;
  readonly totalAbsoluteDifferenceMinor: number;
}

export class ShadowPayrollComparisonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ShadowPayrollComparisonError';
  }
}

/** 旧、新工资结果的确定性行级比较；不使用容差，也不允许浮点金额。 */
export function compareShadowPayroll(
  input: ShadowPayrollComparisonInput,
): ShadowPayrollComparisonResult {
  validateInput(input);
  const legacy = normalizedLegacy(input.legacyLines);
  const erp = normalizedErp(input.erpLines);
  const manifestHash = shadowPayrollManifestHash({
    period: input.period,
    sourceSystem: input.sourceSystem,
    sourceExportId: input.sourceExportId,
    lines: legacy,
  });
  if (manifestHash !== input.sourceManifestHash) invalid(
    'SHADOW_PAYROLL_SOURCE_MANIFEST_HASH_MISMATCH', '旧工资清单摘要不一致',
  );
  const erpResultHash = payrollDigest(erp.map((line) => ({
    employeeId: line.employeeId, resultHash: line.resultHash,
  })));
  if (erpResultHash !== input.payrollResultHash) invalid(
    'SHADOW_PAYROLL_ERP_RESULT_HASH_MISMATCH', 'ERP 工资结果摘要不一致',
  );

  const legacyByEmployee = new Map(legacy.map((line) => [line.employeeId, line]));
  const erpByEmployee = new Map(erp.map((line) => [line.employeeId, line]));
  const employeeIds = [...new Set([...legacyByEmployee.keys(), ...erpByEmployee.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const differences: ShadowPayrollDifference[] = [];
  for (const employeeId of employeeIds) {
    const erpLine = erpByEmployee.get(employeeId);
    const legacyLine = legacyByEmployee.get(employeeId);
    if (legacyLine === undefined && erpLine !== undefined) {
      differences.push(difference(
        employeeId, 'LEGACY_EMPLOYEE_MISSING', erpLine.netPayMinor, 0,
      ));
      continue;
    }
    if (erpLine === undefined && legacyLine !== undefined) {
      differences.push(difference(
        employeeId, 'ERP_EMPLOYEE_MISSING', 0, legacyLine.netPayMinor,
      ));
      continue;
    }
    if (erpLine === undefined || legacyLine === undefined) continue;
    compareAmount(differences, employeeId, 'GROSS_AMOUNT_MISMATCH',
      erpLine.grossPayMinor, legacyLine.grossPayMinor);
    compareAmount(differences, employeeId, 'WITHHOLDING_TAX_MISMATCH',
      erpLine.withholdingTaxMinor, legacyLine.withholdingTaxMinor);
    compareAmount(differences, employeeId, 'NET_AMOUNT_MISMATCH',
      erpLine.netPayMinor, legacyLine.netPayMinor);
  }

  const erpTotals = totals(erp);
  const legacyTotals = totals(legacy);
  const totalAbsoluteDifference = differences.reduce((sum, item) =>
    item.deltaMinor === null ? sum : sum + abs(BigInt(item.deltaMinor)), 0n);
  const totalAbsoluteDifferenceMinor = safeNumber(totalAbsoluteDifference);
  const differenceCodes = [...new Set(differences.map((item) => item.code))].sort();
  const comparisonHash = payrollDigest({
    contract: 'GAOQ_SHADOW_PAYROLL_COMPARISON_V1',
    period: input.period,
    payrollRunId: input.payrollRunId,
    payrollResultHash: input.payrollResultHash,
    sourceSystem: input.sourceSystem,
    sourceExportId: input.sourceExportId,
    sourceObjectEvidenceId: input.sourceObjectEvidenceId,
    sourceSignatureEvidenceId: input.sourceSignatureEvidenceId,
    sourceManifestHash: input.sourceManifestHash,
    erp,
    legacy,
    differences,
  });
  return Object.freeze({
    comparisonHash,
    differenceCodes: Object.freeze(differenceCodes),
    differences: Object.freeze(differences),
    erpEmployeeCount: erp.length,
    legacyEmployeeCount: legacy.length,
    erpTotalGrossMinor: erpTotals.gross,
    legacyTotalGrossMinor: legacyTotals.gross,
    erpTotalTaxMinor: erpTotals.tax,
    legacyTotalTaxMinor: legacyTotals.tax,
    erpTotalNetMinor: erpTotals.net,
    legacyTotalNetMinor: legacyTotals.net,
    totalAbsoluteDifferenceMinor,
  });
}

export function shadowPayrollManifestHash(input: {
  readonly period: string;
  readonly sourceSystem: string;
  readonly sourceExportId: string;
  readonly lines: readonly LegacyShadowPayrollLine[];
}): string {
  if (!MONTH.test(input.period) || !ID.test(input.sourceSystem) || !ID.test(input.sourceExportId)) {
    invalid('SHADOW_PAYROLL_SOURCE_REFERENCE_INVALID', '旧工资来源引用非法');
  }
  return payrollDigest({
    contract: 'GAOQ_LEGACY_PAYROLL_EXPORT_V1',
    period: input.period,
    sourceSystem: input.sourceSystem,
    sourceExportId: input.sourceExportId,
    lines: normalizedLegacy(input.lines),
  });
}

function compareAmount(
  output: ShadowPayrollDifference[],
  employeeId: string,
  code: ShadowPayrollDifferenceCode,
  erpMinor: number,
  legacyMinor: number,
): void {
  if (erpMinor !== legacyMinor) output.push(difference(employeeId, code, erpMinor, legacyMinor));
}

function difference(
  employeeId: string,
  code: ShadowPayrollDifferenceCode,
  erpMinor: number | null,
  legacyMinor: number | null,
): ShadowPayrollDifference {
  const deltaMinor = erpMinor === null || legacyMinor === null
    ? null : safeNumber(BigInt(erpMinor) - BigInt(legacyMinor));
  const item = { employeeId, code, erpMinor, legacyMinor, deltaMinor };
  return Object.freeze({ ...item, evidenceHash: payrollDigest(item) });
}

function normalizedErp(lines: readonly ShadowPayrollLine[]): readonly ShadowPayrollLine[] {
  validateLines(lines, false);
  return Object.freeze([...lines]
    .sort((left, right) => left.employeeId.localeCompare(right.employeeId))
    .map((line) => Object.freeze({ ...line })));
}

function normalizedLegacy(
  lines: readonly LegacyShadowPayrollLine[],
): readonly LegacyShadowPayrollLine[] {
  validateLines(lines, true);
  return Object.freeze([...lines]
    .sort((left, right) => left.employeeId.localeCompare(right.employeeId))
    .map((line) => Object.freeze({ ...line })));
}

function validateLines(
  lines: readonly (ShadowPayrollLine | LegacyShadowPayrollLine)[],
  legacy: boolean,
): void {
  if (
    lines.length < 1 || lines.length > MAX_LINES ||
    new Set(lines.map((line) => line.employeeId)).size !== lines.length
  ) invalid('SHADOW_PAYROLL_LINES_INVALID', '工资比较行数量或员工唯一性非法');
  for (const line of lines) {
    const keys = Object.keys(line).sort().join(',');
    const expected = legacy
      ? 'employeeId,grossPayMinor,netPayMinor,resultHash,sourceLineId,withholdingTaxMinor'
      : 'employeeId,grossPayMinor,netPayMinor,resultHash,withholdingTaxMinor';
    if (
      keys !== expected || !ID.test(line.employeeId) || !HASH.test(line.resultHash) ||
      !minor(line.grossPayMinor, true) || !minor(line.withholdingTaxMinor, false) ||
      !minor(line.netPayMinor, true) ||
      (legacy && (!('sourceLineId' in line) || !ID.test(line.sourceLineId)))
    ) invalid('SHADOW_PAYROLL_LINE_INVALID', '工资比较行格式非法');
  }
  if (legacy && new Set(lines.map((line) =>
    'sourceLineId' in line ? line.sourceLineId : '')).size !== lines.length) {
    invalid('SHADOW_PAYROLL_SOURCE_LINE_DUPLICATE', '旧工资来源行重复');
  }
}

function validateInput(input: ShadowPayrollComparisonInput): void {
  if (
    Object.keys(input).sort().join(',') !==
      'erpLines,legacyLines,payrollResultHash,payrollRunId,period,sourceExportId,sourceManifestHash,sourceObjectEvidenceId,sourceSignatureEvidenceId,sourceSystem' ||
    !MONTH.test(input.period) || !ID.test(input.payrollRunId) ||
    !HASH.test(input.payrollResultHash) || !ID.test(input.sourceSystem) ||
    !ID.test(input.sourceExportId) || !ID.test(input.sourceObjectEvidenceId) ||
    !ID.test(input.sourceSignatureEvidenceId) || !HASH.test(input.sourceManifestHash)
  ) invalid('SHADOW_PAYROLL_INPUT_INVALID', '工资影子比较输入非法');
}

function totals(lines: readonly ShadowPayrollLine[]): { gross: number; tax: number; net: number } {
  return {
    gross: safeNumber(lines.reduce((sum, line) => sum + BigInt(line.grossPayMinor), 0n)),
    tax: safeNumber(lines.reduce((sum, line) => sum + BigInt(line.withholdingTaxMinor), 0n)),
    net: safeNumber(lines.reduce((sum, line) => sum + BigInt(line.netPayMinor), 0n)),
  };
}

function minor(value: number, nonnegative: boolean): boolean {
  return Number.isSafeInteger(value) && (!nonnegative || value >= 0);
}

function safeNumber(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid('SHADOW_PAYROLL_AMOUNT_OVERFLOW', '工资影子比较金额超出安全范围');
  }
  return Number(value);
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function invalid(code: string, message: string): never {
  throw new ShadowPayrollComparisonError(code, message);
}
