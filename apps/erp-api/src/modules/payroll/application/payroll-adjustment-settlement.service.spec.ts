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

function assemble(correctedAmountMinor = 1_100_000) {
  const context = new TenantContextService();
  const originalResult = calculatePayroll(base);
  const correctedInput: PayrollCalculationInput = {
    ...base,
    taxableEarnings: [{ code: 'BASE', amountMinor: correctedAmountMinor }],
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
  let bundle: Record<string, unknown> = {
    originalResult,
    correctedInput,
    correctedResult,
    attendanceSnapshotHash: 's'.repeat(43),
    adjustment,
  };
  const crypto = {
    unprotect: vi.fn(() => bundle),
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
    crypto,
    outbox,
    current: () => current,
    writeCurrent: (value: Record<string, unknown>) => {
      current = value as typeof current;
    },
    bundle: () => bundle,
    writeBundle: (value: Record<string, unknown>) => {
      bundle = value;
    },
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

  it('读取摘要和控制面前执行权限、标识、存在性与密文完整性校验', async () => {
    const store = assemble();
    const reader = actor('user', 'reader', ['erp:payroll:adjustment:read']);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(adjustmentId))).resolves.toMatchObject({
      id: adjustmentId,
      payableMinor: 97_000,
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.getControlStatus(adjustmentId))).resolves.toEqual({
      id: adjustmentId,
      period: '2026-07',
      adjustmentNumber: 1,
      type: 'supplement',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      status: 'locked',
      cashSettlementStatus: 'pending',
      taxCorrectionStatus: 'pending',
      version: 4,
      adjustmentHash: store.adjustment.adjustmentHash,
    });
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', []),
    }, () => store.service.get(adjustmentId))).rejects.toMatchObject({
      response: { code: 'AUTH_SCOPE_DENIED' },
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get('bad'))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_ID_INVALID' },
    });
    store.adjustments.findOne.mockReturnValueOnce(query(() => null) as never);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(adjustmentId))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_NOT_FOUND' },
    });
  });

  it('分别提供正向补发、负向应收和税务更正的最小可信来源', async () => {
    const supplement = assemble();
    supplement.writeCurrent({
      ...supplement.current(),
      requestedBy: null,
      approvalDecidedBy: 'adjustment-engine',
    });
    await expect(supplement.context.run({
      tenant,
      actor: actor('user', 'treasury-maker', [
        'erp:treasury:adjustment:source:read',
      ]),
    }, () => supplement.service.getLockedSupplementSource(
      adjustmentId,
      4,
      session,
    ))).resolves.toMatchObject({
      adjustmentId,
      payableMinor: 97_000,
      controlActorIds: ['adjustment-engine', 'adjustment-locker'],
    });

    const reversal = assemble(900_000);
    await expect(reversal.context.run({
      tenant,
      actor: actor('user', 'receivable-maker', [
        'erp:payroll:adjustment:receivable:source:read',
      ]),
    }, () => reversal.service.getLockedReversalSource(
      adjustmentId,
      4,
      session,
    ))).resolves.toMatchObject({
      adjustmentId,
      receivableMinor: 97_000,
      adjustmentVersion: 4,
    });

    await expect(supplement.context.run({
      tenant,
      actor: actor('user', 'tax-maker', [
        'erp:payroll:adjustment:tax_correction:source:read',
      ]),
    }, () => supplement.service.getLockedTaxCorrectionSource(
      adjustmentId,
      4,
      session,
    ))).resolves.toMatchObject({
      adjustmentId,
      originalTaxableEarningsMinor: 1_000_000,
      correctedTaxableEarningsMinor: 1_100_000,
      taxableEarningsDeltaMinor: 100_000,
    });
  });

  it('拒绝不满足补发、应收或税务更正前置状态的来源', async () => {
    const supplementChanges = [
      { status: 'settled' },
      { version: 5 },
      { cashSettlementStatus: 'settled' },
      { lockedBy: null },
    ];
    for (const change of supplementChanges) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('user', 'treasury-maker', [
          'erp:treasury:adjustment:source:read',
        ]),
      }, () => store.service.getLockedSupplementSource(
        adjustmentId,
        4,
        session,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_SUPPLEMENT_SOURCE_INVALID' },
      });
    }
    const wrongType = assemble(900_000);
    await expect(wrongType.context.run({
      tenant,
      actor: actor('user', 'treasury-maker', [
        'erp:treasury:adjustment:source:read',
      ]),
    }, () => wrongType.service.getLockedSupplementSource(
      adjustmentId,
      4,
      session,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_SUPPLEMENT_SOURCE_INVALID' },
    });

    for (const change of [
      { status: 'settled' },
      { version: 5 },
      { cashSettlementStatus: 'settled' },
      { cashSettlementReferenceType: 'receivable' },
      { cashSettlementReferenceId: 'receivable-001' },
    ]) {
      const store = assemble(900_000);
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('user', 'receivable-maker', [
          'erp:payroll:adjustment:receivable:source:read',
        ]),
      }, () => store.service.getLockedReversalSource(
        adjustmentId,
        4,
        session,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SOURCE_INVALID' },
      });
    }

    for (const change of [
      { status: 'settled' },
      { version: 5 },
      { taxCorrectionStatus: 'submitted' },
      { taxCorrectionFilingId: filingId },
    ]) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('user', 'tax-maker', [
          'erp:payroll:adjustment:tax_correction:source:read',
        ]),
      }, () => store.service.getLockedTaxCorrectionSource(
        adjustmentId,
        4,
        session,
      ))).rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SOURCE_INVALID',
        },
      });
    }
  });

  it.each([
    actor('service', 'service-maker', [
      'erp:payroll:adjustment:tax_correction:prepare',
    ]),
    actor('user', 'missing-prepare', []),
  ])('拒绝不可信税务更正绑定主体：$actorId', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.recordTaxCorrectionPrepared({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        filingId,
        expectedVersion: 4,
      }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARER_DENIED' },
    });
  });

  it.each([
    { adjustmentId: 'bad' },
    { adjustmentHash: 'bad' },
    { filingId: 'bad' },
    { expectedVersion: 0 },
    { expectedVersion: Number.NaN },
  ])('拒绝非法税务更正绑定输入 %#', async (change) => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'tax-maker', [
        'erp:payroll:adjustment:tax_correction:prepare',
      ]),
    }, () => store.service.recordTaxCorrectionPrepared({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      filingId,
      expectedVersion: 4,
      ...change,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_INVALID' },
    });
  });

  it('拒绝税务更正绑定状态和并发写入冲突', async () => {
    for (const change of [
      { status: 'settled' },
      { version: 5 },
      { taxCorrectionStatus: 'submitted' },
      { taxCorrectionFilingId: filingId },
    ]) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('user', 'tax-maker', [
          'erp:payroll:adjustment:tax_correction:prepare',
        ]),
      }, () => store.service.recordTaxCorrectionPrepared({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        filingId,
        expectedVersion: 4,
      }, session))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_CONFLICT' },
      });
    }
    const conflict = assemble();
    conflict.adjustments.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({
      tenant,
      actor: actor('user', 'tax-maker', [
        'erp:payroll:adjustment:tax_correction:prepare',
      ]),
    }, () => conflict.service.recordTaxCorrectionPrepared({
      adjustmentId,
      adjustmentHash: conflict.adjustment.adjustmentHash,
      filingId,
      expectedVersion: 4,
    }, session))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_WRITE_CONFLICT',
      },
    });
  });

  it.each([
    actor('user', 'human-submitter', [
      'erp:payroll:adjustment:tax_correction:submit',
    ]),
    actor('service', 'missing-submit', []),
  ])('拒绝不可信税务终态写入主体：$actorId', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.recordTaxCorrectionSubmitted({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        filingId,
      }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMITTER_DENIED' },
    });
  });

  it.each([
    { adjustmentId: 'bad' },
    { adjustmentHash: 'bad' },
    { filingId: 'bad' },
  ])('拒绝非法税务终态引用 %#', async (change) => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: actor('service', 'tax-connector', [
        'erp:payroll:adjustment:tax_correction:submit',
      ]),
    }, () => store.service.recordTaxCorrectionSubmitted({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      filingId,
      ...change,
    }, session))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_INVALID',
      },
    });
  });

  it('拒绝税务终态状态和并发写入冲突', async () => {
    for (const change of [
      { status: 'settled' },
      { adjustmentHash: 'x'.repeat(43) },
      { taxCorrectionStatus: 'submitted' },
      { taxCorrectionFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F9' },
    ]) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), taxCorrectionFilingId: filingId });
      const inputHash = change.adjustmentHash ?? store.adjustment.adjustmentHash;
      if ('adjustmentHash' in change) {
        delete change.adjustmentHash;
      }
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('service', 'tax-connector', [
          'erp:payroll:adjustment:tax_correction:submit',
        ]),
      }, () => store.service.recordTaxCorrectionSubmitted({
        adjustmentId,
        adjustmentHash: inputHash,
        filingId,
      }, session))).rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_CONFLICT',
        },
      });
    }
    const conflict = assemble();
    conflict.writeCurrent({ ...conflict.current(), taxCorrectionFilingId: filingId });
    conflict.adjustments.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({
      tenant,
      actor: actor('service', 'tax-connector', [
        'erp:payroll:adjustment:tax_correction:submit',
      ]),
    }, () => conflict.service.recordTaxCorrectionSubmitted({
      adjustmentId,
      adjustmentHash: conflict.adjustment.adjustmentHash,
      filingId,
    }, session))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_WRITE_CONFLICT',
      },
    });
  });

  it('负向调整应收建立与归零回写保持独立状态机', async () => {
    const store = assemble(900_000);
    const receivableId = '01J8ZQK7V0A2M4N6P8R0T2W4Q1';
    const recoveryId = '01J8ZQK7V0A2M4N6P8R0T2W4Y1';
    const serviceActor = actor('service', 'receivable-service', []);
    await store.context.run({ tenant, actor: serviceActor }, () =>
      store.service.recordReceivableOpened({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      receivableId,
      expectedVersion: 4,
      }, session));
    expect(store.current()).toMatchObject({
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: receivableId,
      version: 5,
    });
    await store.context.run({ tenant, actor: serviceActor }, () =>
      store.service.recordReceivableSettled({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      receivableId,
      recoveryId,
      }, session));
    expect(store.current()).toMatchObject({
      cashSettlementStatus: 'settled',
      cashSettlementEvidenceId: recoveryId,
      status: 'locked',
      version: 6,
    });
  });

  it.each([
    { adjustmentId: 'bad' },
    { adjustmentHash: 'bad' },
    { receivableId: 'bad' },
    { expectedVersion: 0 },
    { expectedVersion: Number.NaN },
  ])('拒绝非法应收绑定输入 %#', async (change) => {
    const store = assemble(900_000);
    await expect(store.service.recordReceivableOpened({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      receivableId: '01J8ZQK7V0A2M4N6P8R0T2W4Q1',
      expectedVersion: 4,
      ...change,
    }, session)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_INVALID' },
    });
  });

  it('拒绝应收绑定状态和并发冲突', async () => {
    for (const change of [
      { status: 'settled' },
      { version: 5 },
      { cashSettlementStatus: 'settled' },
      { cashSettlementReferenceType: 'receivable' },
      { cashSettlementReferenceId: 'receivable-001' },
    ]) {
      const store = assemble(900_000);
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('service', 'receivable-service', []),
      }, () => store.service.recordReceivableOpened({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        receivableId: '01J8ZQK7V0A2M4N6P8R0T2W4Q1',
        expectedVersion: 4,
      }, session))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_CONFLICT' },
      });
    }
    const conflict = assemble(900_000);
    conflict.adjustments.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({
      tenant,
      actor: actor('service', 'receivable-service', []),
    }, () => conflict.service.recordReceivableOpened({
      adjustmentId,
      adjustmentHash: conflict.adjustment.adjustmentHash,
      receivableId: '01J8ZQK7V0A2M4N6P8R0T2W4Q1',
      expectedVersion: 4,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_WRITE_CONFLICT' },
    });
  });

  it.each([
    { adjustmentId: 'bad' },
    { adjustmentHash: 'bad' },
    { receivableId: 'bad' },
    { recoveryId: 'bad' },
  ])('拒绝非法应收结算引用 %#', async (change) => {
    const store = assemble(900_000);
    await expect(store.service.recordReceivableSettled({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      receivableId: '01J8ZQK7V0A2M4N6P8R0T2W4Q1',
      recoveryId: '01J8ZQK7V0A2M4N6P8R0T2W4Y1',
      ...change,
    }, session)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_INVALID' },
    });
  });

  it('拒绝应收结算状态和并发冲突，并在税务已终结时整体结算', async () => {
    const receivableId = '01J8ZQK7V0A2M4N6P8R0T2W4Q1';
    const recoveryId = '01J8ZQK7V0A2M4N6P8R0T2W4Y1';
    for (const change of [
      { status: 'settled' },
      { cashSettlementStatus: 'settled' },
      { cashSettlementReferenceType: null },
      { cashSettlementReferenceId: 'other-receivable' },
      { cashSettlementEvidenceId: 'existing-evidence' },
    ]) {
      const store = assemble(900_000);
      store.writeCurrent({
        ...store.current(),
        cashSettlementReferenceType: 'receivable',
        cashSettlementReferenceId: receivableId,
        ...change,
      });
      await expect(store.context.run({
        tenant,
        actor: actor('service', 'receivable-service', []),
      }, () => store.service.recordReceivableSettled({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        receivableId,
        recoveryId,
      }, session))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_CONFLICT' },
      });
    }
    const conflict = assemble(900_000);
    conflict.writeCurrent({
      ...conflict.current(),
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: receivableId,
    });
    conflict.adjustments.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({
      tenant,
      actor: actor('service', 'receivable-service', []),
    }, () => conflict.service.recordReceivableSettled({
      adjustmentId,
      adjustmentHash: conflict.adjustment.adjustmentHash,
      receivableId,
      recoveryId,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_WRITE_CONFLICT' },
    });

    const settled = assemble(900_000);
    settled.writeCurrent({
      ...settled.current(),
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: receivableId,
      taxCorrectionStatus: 'submitted',
    });
    await settled.context.run({
      tenant,
      actor: actor('service', 'receivable-service', []),
    }, () => settled.service.recordReceivableSettled({
      adjustmentId,
      adjustmentHash: settled.adjustment.adjustmentHash,
      receivableId,
      recoveryId,
    }, session));
    expect(settled.current().status).toBe('settled');
  });

  it.each([
    actor('user', 'human-return', ['erp:treasury:return:ingest']),
    actor('service', 'missing-return-scope', []),
  ])('拒绝不可信补发回盘主体：$actorId', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.recordSupplementBankReturn({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        batchId,
        returnId,
        successfulMinor: 97_000,
      }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_WRITER_DENIED' },
    });
  });

  it.each([
    { adjustmentId: 'bad' },
    { adjustmentHash: 'bad' },
    { batchId: 'bad' },
    { returnId: 'bad' },
    { successfulMinor: 0 },
    { successfulMinor: Number.NaN },
  ])('拒绝非法补发回盘输入 %#', async (change) => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: actor('service', 'return-connector', [
        'erp:treasury:return:ingest',
      ]),
    }, () => store.service.recordSupplementBankReturn({
      adjustmentId,
      adjustmentHash: store.adjustment.adjustmentHash,
      batchId,
      returnId,
      successfulMinor: 97_000,
      ...change,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_INPUT_INVALID' },
    });
  });

  it('拒绝补发回盘状态和并发冲突，并在税务已提交时整体结算', async () => {
    for (const change of [
      { status: 'settled' },
      { cashSettlementStatus: 'settled' },
    ]) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({
        tenant,
        actor: actor('service', 'return-connector', [
          'erp:treasury:return:ingest',
        ]),
      }, () => store.service.recordSupplementBankReturn({
        adjustmentId,
        adjustmentHash: store.adjustment.adjustmentHash,
        batchId,
        returnId,
        successfulMinor: 97_000,
      }, session))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_STATE_INVALID' },
      });
    }
    const amountMismatch = assemble();
    await expect(amountMismatch.context.run({
      tenant,
      actor: actor('service', 'return-connector', [
        'erp:treasury:return:ingest',
      ]),
    }, () => amountMismatch.service.recordSupplementBankReturn({
      adjustmentId,
      adjustmentHash: amountMismatch.adjustment.adjustmentHash,
      batchId,
      returnId,
      successfulMinor: 1,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_STATE_INVALID' },
    });
    const conflict = assemble();
    conflict.adjustments.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({
      tenant,
      actor: actor('service', 'return-connector', [
        'erp:treasury:return:ingest',
      ]),
    }, () => conflict.service.recordSupplementBankReturn({
      adjustmentId,
      adjustmentHash: conflict.adjustment.adjustmentHash,
      batchId,
      returnId,
      successfulMinor: 97_000,
    }, session))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_WRITE_CONFLICT' },
    });

    const settled = assemble();
    settled.writeCurrent({
      ...settled.current(),
      taxCorrectionStatus: 'submitted',
    });
    await settled.context.run({
      tenant,
      actor: actor('system_job', 'return-connector', [
        'erp:treasury:return:ingest',
      ]),
    }, () => settled.service.recordSupplementBankReturn({
      adjustmentId,
      adjustmentHash: settled.adjustment.adjustmentHash,
      batchId,
      returnId,
      successfulMinor: 97_000,
    }, session));
    expect(settled.current().status).toBe('settled');
  });

  it('受保护结构或控制字段被篡改时失败关闭', async () => {
    const reader = actor('user', 'reader', ['erp:payroll:adjustment:read']);
    const malformed = assemble();
    malformed.writeBundle({});
    await expect(malformed.context.run({ tenant, actor: reader }, () =>
      malformed.service.get(adjustmentId))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_PROTECTED_DATA_INVALID' },
    });

    const changes = [
      { adjustmentHash: 'x'.repeat(43) },
      { type: 'reversal' },
      { reasonCode: 'OTHER_REASON' },
      { originalResultHash: 'x'.repeat(43) },
      { correctedInputHash: 'x'.repeat(43) },
      { correctedResultHash: 'x'.repeat(43) },
      { grossDeltaMinor: 1 },
      { taxDeltaMinor: 1 },
      { netDeltaMinor: 1 },
      { payableMinor: 1 },
      { receivableMinor: 1 },
    ];
    for (const change of changes) {
      const store = assemble();
      store.writeCurrent({ ...store.current(), ...change });
      await expect(store.context.run({ tenant, actor: reader }, () =>
        store.service.get(adjustmentId))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECORD_INTEGRITY_FAILED' },
      });
    }
  });
});
