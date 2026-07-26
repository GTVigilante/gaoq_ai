import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { calculatePayroll, type PayrollCalculationInput } from '../domain/index.js';
import { PayrollAnnualReconciliationService } from './payroll-annual-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const employeeId = 'employee-001';
const januaryPeriodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const februaryPeriodId = '01J8ZQK7V0A2M4N6P8R0T2W4P2';
const januaryRunId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const februaryRunId = '01J8ZQK7V0A2M4N6P8R0T2W4R2';
const januaryInputId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const februaryInputId = '01J8ZQK7V0A2M4N6P8R0T2W4A2';
const januaryLineId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';
const februaryLineId = '01J8ZQK7V0A2M4N6P8R0T2W4N2';
const januaryFilingId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const februaryFilingId = '01J8ZQK7V0A2M4N6P8R0T2W4F2';

const january: PayrollCalculationInput = {
  tenantId: tenant.tenantId, employeeId, period: '2026-01',
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

function actor(): ActorContext {
  return {
    actorType: 'service', actorId: 'annual-tax-service', tenantId: tenant.tenantId,
    roleCodes: [], scopes: ['erp:payroll:annual:prepare'],
    departmentIds: [], traceId: 'trace-annual-001',
  };
}

function query<T>(value: T) {
  const result = {
    sort: vi.fn(() => result),
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn().mockResolvedValue(value),
  };
  return result;
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const periods = { find: vi.fn().mockReturnValue(query([
    {
      id: januaryPeriodId, period: '2026-01', status: 'reconciled',
      activeRunId: januaryRunId,
    },
    {
      id: februaryPeriodId, period: '2026-02', status: 'reconciled',
      activeRunId: februaryRunId,
    },
  ])) };
  const inputs = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryInputId : februaryInputId,
    inputHash: filter.periodId === januaryPeriodId
      ? januaryResult.inputHash : februaryResult.inputHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'input', dataAuthTag: 'tag',
  })) };
  const results = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryLineId : februaryLineId,
    resultHash: filter.periodId === januaryPeriodId
      ? januaryResult.resultHash : februaryResult.resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'result', dataAuthTag: 'tag',
  })) };
  const filings = { findOne: vi.fn((filter: { periodId: string }) => query({
    id: filter.periodId === januaryPeriodId ? januaryFilingId : februaryFilingId,
    contentHash: filter.periodId === januaryPeriodId ? 'j'.repeat(43) : 'f'.repeat(43),
    taxSubmissionEvidenceId: filter.periodId === januaryPeriodId
      ? 'tax-evidence-jan' : 'tax-evidence-feb',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'filing', dataAuthTag: 'tag',
  })) };
  const annualRecords = {
    findOne: vi.fn().mockReturnValue(query(null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const protectedBundles: unknown[] = [];
  const crypto = {
    unprotect: vi.fn((aad: { resourceType: string; resourceId: string }) => {
      if (aad.resourceType === 'input_snapshot') {
        return aad.resourceId === januaryInputId ? january : february;
      }
      if (aad.resourceType === 'calculation_line') {
        return aad.resourceId === januaryLineId ? januaryResult : februaryResult;
      }
      const isJanuary = aad.resourceId === januaryFilingId;
      return { content: JSON.stringify({
        schema: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
        lines: [{
          employeeId,
          calculationLineId: isJanuary ? januaryLineId : februaryLineId,
          withholdingTaxMinor: isJanuary
            ? januaryResult.withholdingTaxMinor : februaryResult.withholdingTaxMinor,
          resultHash: isJanuary ? januaryResult.resultHash : februaryResult.resultHash,
        }],
      }) };
    }),
    protect: vi.fn((_aad: unknown, value: unknown) => {
      protectedBundles.push(value);
      return {
        keyId: 'annual-key', iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(32), authTag: 'a'.repeat(22),
      };
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollAnnualReconciliationService(
    idempotency as never, context, crypto as never, outbox as never,
    periods as never, inputs as never, results as never, filings as never,
    annualRecords as never,
  );
  return { context, service, annualRecords, outbox, protectedBundles };
}

describe('PayrollAnnualReconciliationService', () => {
  it('重放锁定工资并核对逐月已提交税表后追加年度证据', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('annual-001', { employeeId, taxYear: '2026' }));

    expect(result).toMatchObject({
      employeeId, taxYear: '2026', version: 1, periodCount: 2,
      totalPayrollWithheldMinor: 21_000, totalFiledWithholdingMinor: 21_000,
      status: 'awaiting_assessment', differences: [],
    });
    expect(store.annualRecords.create).toHaveBeenCalledWith([
      expect.objectContaining({
        employeeId, taxYear: '2026', status: 'awaiting_assessment',
        officialAssessmentId: null, preparedBy: 'annual-tax-service',
      }),
    ], { session });
    const bundle = store.protectedBundles[0] as {
      readonly result: { readonly evidenceHash: string };
      readonly sourceReferences: readonly {
        readonly period: string;
        readonly filingId: string;
      }[];
    };
    expect(bundle.result.evidenceHash).toBe(result.evidenceHash);
    expect(bundle.sourceReferences).toMatchObject([
      { period: '2026-01', filingId: januaryFilingId },
      { period: '2026-02', filingId: februaryFilingId },
    ]);
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(JSON.stringify(event.data)).not.toMatch(/employee|21000|tax-evidence/u);
  });
});
