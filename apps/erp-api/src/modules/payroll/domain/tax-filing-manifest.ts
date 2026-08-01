import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface TaxFilingManifestLine {
  readonly employeeId: string;
  readonly calculationLineId: string;
  readonly identityEvidenceId: string;
  readonly taxableEarningsMinor: number;
  readonly withholdingTaxMinor: number;
  readonly cumulativeTaxableIncomeMinor: number;
  readonly cumulativeTaxWithheldMinor: number;
  readonly resultHash: string;
}

export interface TaxFilingManifestInput {
  readonly filingId: string;
  readonly tenantId: string;
  readonly period: string;
  readonly payrollRunId: string;
  readonly payrollResultHash: string;
  readonly lines: readonly TaxFilingManifestLine[];
}

export interface GeneratedTaxFilingManifest {
  readonly format: 'CN_IIT_WITHHOLDING_MANIFEST_V1';
  readonly content: string;
  readonly contentHash: string;
  readonly employeeCount: number;
  readonly totalTaxableEarningsMinor: number;
  readonly totalWithholdingTaxMinor: number;
}

export class TaxFilingManifestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaxFilingManifestError';
  }
}

/** 生成税务隔离网关的确定性内部清单；它不是税局官方上传格式。 */
export function generateTaxFilingManifest(
  input: TaxFilingManifestInput,
): GeneratedTaxFilingManifest {
  assertRoot(input);
  const lines = [...input.lines].sort((left, right) =>
    left.employeeId.localeCompare(right.employeeId));
  assertLines(lines);
  const totalTaxable = sum(lines.map((line) => line.taxableEarningsMinor), false);
  const totalTax = sum(lines.map((line) => line.withholdingTaxMinor), true);
  const content = JSON.stringify({
    schema: 'CN_IIT_WITHHOLDING_MANIFEST_V1', filingId: input.filingId,
    tenantId: input.tenantId, period: input.period, payrollRunId: input.payrollRunId,
    payrollResultHash: input.payrollResultHash, currency: 'CNY',
    employeeCount: lines.length, totalTaxableEarningsMinor: totalTaxable,
    totalWithholdingTaxMinor: totalTax,
    lines: lines.map((line) => ({
      employeeId: line.employeeId, calculationLineId: line.calculationLineId,
      identityEvidenceId: line.identityEvidenceId,
      taxableEarningsMinor: line.taxableEarningsMinor,
      withholdingTaxMinor: line.withholdingTaxMinor,
      cumulativeTaxableIncomeMinor: line.cumulativeTaxableIncomeMinor,
      cumulativeTaxWithheldMinor: line.cumulativeTaxWithheldMinor,
      resultHash: line.resultHash,
    })),
  });
  return Object.freeze({
    format: 'CN_IIT_WITHHOLDING_MANIFEST_V1', content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('base64url'),
    employeeCount: lines.length, totalTaxableEarningsMinor: totalTaxable,
    totalWithholdingTaxMinor: totalTax,
  });
}

function assertRoot(input: TaxFilingManifestInput): void {
  if (
    !ULID.test(input.filingId) || !ID.test(input.tenantId) || !MONTH.test(input.period) ||
    !ULID.test(input.payrollRunId) || !HASH.test(input.payrollResultHash) ||
    input.lines.length < 1 || input.lines.length > 5_000
  ) invalid('PAYROLL_TAX_MANIFEST_INPUT_INVALID', '税务清单根引用或行数非法');
}

function assertLines(lines: readonly TaxFilingManifestLine[]): void {
  if (
    new Set(lines.map((line) => line.employeeId)).size !== lines.length ||
    new Set(lines.map((line) => line.calculationLineId)).size !== lines.length ||
    new Set(lines.map((line) => line.identityEvidenceId)).size !== lines.length
  ) invalid('PAYROLL_TAX_MANIFEST_LINE_DUPLICATED', '税务清单员工、工资行或身份凭证重复');
  for (const line of lines) {
    if (
      !ID.test(line.employeeId) || !ULID.test(line.calculationLineId) ||
      !ID.test(line.identityEvidenceId) || !HASH.test(line.resultHash) ||
      !nonnegative(line.taxableEarningsMinor) || !signed(line.withholdingTaxMinor) ||
      !nonnegative(line.cumulativeTaxableIncomeMinor) ||
      !nonnegative(line.cumulativeTaxWithheldMinor)
    ) invalid('PAYROLL_TAX_MANIFEST_LINE_INVALID', '税务清单员工行非法');
  }
}

function sum(values: readonly number[], signedAmount: boolean): number {
  const total = values.reduce((current, value) => current + BigInt(value), 0n);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (total > limit || total < (signedAmount ? -limit : 0n)) {
    invalid('PAYROLL_TAX_MANIFEST_TOTAL_OVERFLOW', '税务清单汇总金额溢出');
  }
  return Number(total);
}

function nonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function signed(value: number): boolean {
  return Number.isSafeInteger(value);
}

function invalid(code: string, message: string): never {
  throw new TaxFilingManifestError(code, message);
}
