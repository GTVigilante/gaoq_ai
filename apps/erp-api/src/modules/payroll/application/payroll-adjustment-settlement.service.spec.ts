import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  calculatePayroll,
  createPayrollAdjustment,
  type PayrollCalculationInput,
} from '../domain/index.js';
import { PayrollAdjustmentService } from './payroll-adjustment.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const filingId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const batchId = '01J8ZQK7V0A2M4N6P8R0T2W4B1';
const returnId = '01J8ZQK7V0A2M4N6P8R0T2W4R2';
const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const runId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const lineId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';

const base: PayrollCalculationInput = {
  tenantId: tenant.tenantId,
  employeeId: 'employee-001',
  period: '2026-07',
  currency: 'CNY',
  engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4K1',
    version: 1,
    monthlyBasicDeductionMinor: 500_000,
    roundingMode: 'HALF_UP',
    taxBrackets: [{
      upperBoundMinor: null,
      rateBps: 300,
      quickDeductionMinor: 0,
    }],
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
  nonTaxableEarnings: [],
  employeeSocialInsuranceMinor: 100_000,
  employeeHousingFundMinor: 50_000,
  specialAdditionalDeductionMinor: 0,
  otherPreTaxWithholdingMinor: 0,
  postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0,
    basicDeductionMinor: 0,
    socialInsuranceMinor: 0,
    housingFundMinor: 0,
    specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0,
    taxWithheldMinor: 0,
  },
};

function actor(
  actorType: ActorContext['actorType'],
  actorId: string,
  scopes: readonly string[],
): ActorContext {
  return {
    actorType,
    actorId,
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: `trace-${actorId}`,
  };
}

function query<T>(read: () => T) {
  const result = {
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn(() => Promise.resolve(read())),
  };
  return result;
}

function assemble() {
  const context = new TenantContextService();
  const originalResult = calculatePayroll(base);
  const correctedInput: PayrollCalculationInput = {
    ...base,
    taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
  };
  const correctedResult = calculatePayroll(correctedInput);
  const adjustment = createPayrollAdjustment({
    tenantId: tenant.tenantId,
    employeeId: base.employeeId,
    period: base.period,
    originalCalculationLineId: lineId,
    reasonCode: 'RETROACTIVE_SALARY_CHANGE',
    originalPeriodStatus: 'locked',
    original: originalResult,
    corrected: correctedResult,
  });
  let current = {
    id: adjustmentId,
    tenantId: tenant.tenantId,
    periodId,
    period: base.period,
    originalRunId: runId,
    originalCalculationLineId: lineId,
    employeeId: base.employeeId,
    adjustmentNumber: 1,
    type: adjustment.type,
    reasonCode: adjustment.reasonCode,
    originalResultHash: adjustment.originalResultHash,
    correctedInputHash: adjustment.correctedInputHash,
    correctedResultHash: adjustment.correctedResultHash,
    adjustmentHash: adjustment.adjustmentHash,
    grossDeltaMinor: adjustment.delta.grossPayMinor,
    taxDeltaMinor: adjustment.delta.withholdingTaxMinor,
    netDeltaMinor: adjustment.delta.netPayMinor,
    payableMinor: adjustment.payableMinor,
    receivableMinor: adjustment.receivableMinor,
    preparedBy: 'adjustment-engine',
    requestedBy: 'payroll-requester',
    approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    approvalDecidedBy: 'finance-approver',
    approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    lockedBy: 'adjustment-locker',
    strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    cashSettlementStatus: 'pending' as const,
    taxCorrectionStatus: 'pending' as const,
    cashSettlementReferenceType: null,
    cashSettlementReferenceId: null,
    cashSettlementEvidenceId: null,
    taxCorrectionFilingId: null,
    status: 'locked' as const,
    version: 4,
    dataKeyId: 'key',
    dataIv: 'iv',
    dataCiphertext: 'cipher',
    dataAuthTag: 'tag',
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
  };
  const adjustments = {
    findOne: vi.fn(() => query(() => current)),
    updateOne: vi.fn((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      current = { ...current, ...update.$set };
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };
  const crypto = {
    unprotect: vi.fn().mockReturnValue({
      originalResult,
      correctedInput,
      correctedResult,
      attendanceSnapshotHash: 's'.repeat(43),
      adjustment,
    }),
  };
  const outbox = {
    append: vi.fn<(
      event: {
        readonly type: string;
        readonly version: number;
        readonly data: Readonly<Record<string, unknown>>;
      },
      session: ClientSession,
    ) => Promise<void>>().mockResolvedValue(undefined),
  };
  const service = new PayrollAdjustmentService(
    {} as never,
    context,
    {} as never,
    {} as never,
    {} as never,
    crypto as never,
    outbox as never,
    {} as never,
    {} as never,
    adjustments as never,
  );
  return {
    context,
    service,
    adjustments,
    outbox,
    current: () => current,
    adjustment,
  };
}

describe('PayrollAdjustmentService 结算状态机', () => {
  it('现金先结算、税务后提交时只在两个子状态均终结后进入 settled', async () => {
    const store = assemble();
    await store.context.run({
      tenant,
      actor: actor('service', 'treasury-return-connector', [
        'erp:treasury:return:ingest',
      ]),
    }, () => store.service.recordSupplementBankReturn({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      batchId,
      returnId,
      successfulMinor: store.adjustment.payableMinor,
    }, session));
    expect(store.current()).toMatchObject({
      cashSettlementStatus: 'settled',
      taxCorrectionStatus: 'pending',
      status: 'locked',
      version: 5,
    });

    const source = await store.context.run({
      tenant,
      actor: actor('user', 'tax-correction-maker', [
        'erp:payroll:adjustment:tax_correction:source:read',
      ]),
    }, () => store.service.getLockedTaxCorrectionSource(
      adjustmentId,
      5,
      session,
    ));
    expect(source).toMatchObject({
      adjustmentId,
      correctedTaxableEarningsMinor: 1_100_000,
      withholdingTaxDeltaMinor: 3_000,
    });
    expect(JSON.stringify(source)).not.toContain('correctedInput');

    await store.context.run({
      tenant,
      actor: actor('user', 'tax-correction-maker', [
        'erp:payroll:adjustment:tax_correction:prepare',
      ]),
    }, () => store.service.recordTaxCorrectionPrepared({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      filingId,
      expectedVersion: 5,
    }, session));
    expect(store.current()).toMatchObject({
      taxCorrectionFilingId: filingId,
      taxCorrectionStatus: 'pending',
      status: 'locked',
      version: 6,
    });

    await store.context.run({
      tenant,
      actor: actor('service', 'tax-correction-connector', [
        'erp:payroll:adjustment:tax_correction:submit',
      ]),
    }, () => store.service.recordTaxCorrectionSubmitted({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      filingId,
    }, session));
    expect(store.current()).toMatchObject({
      cashSettlementStatus: 'settled',
      taxCorrectionStatus: 'submitted',
      status: 'settled',
      version: 7,
    });
    expect(store.outbox.append.mock.calls.map(([event]) => event.type)).toEqual([
      'payroll.adjustment.cash_settled',
      'payroll.adjustment.tax_correction_prepared',
      'payroll.adjustment.tax_correction_submitted',
    ]);
  });
});
