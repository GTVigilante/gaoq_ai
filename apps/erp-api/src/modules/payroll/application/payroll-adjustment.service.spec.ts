import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { calculatePayroll, type PayrollCalculationInput } from '../domain/index.js';
import { PayrollAdjustmentService } from './payroll-adjustment.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const runId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const lineId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';
const rulePackId = '01J8ZQK7V0A2M4N6P8R0T2W4K1';
const attendanceId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const profileId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';

const base: PayrollCalculationInput = {
  tenantId: tenant.tenantId, employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: rulePackId, version: 1, monthlyBasicDeductionMinor: 500_000,
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

function actor(
  actorType: ActorContext['actorType'] = 'system_job',
  scopes: readonly string[] = ['erp:payroll:adjustment:prepare'],
): ActorContext {
  return {
    actorType, actorId: 'payroll-adjustment-engine', tenantId: tenant.tenantId,
    roleCodes: [], scopes,
    departmentIds: [], traceId: 'trace-adjustment-001',
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

function assemble(boundary = { assertLegacy: vi.fn() }) {
  const context = new TenantContextService();
  const original = calculatePayroll(base);
  const correctedInput: PayrollCalculationInput = {
    ...base, taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
  };
  const corrected = calculatePayroll(correctedInput);
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const periods = { findOne: vi.fn().mockReturnValue(query({
    id: periodId, tenantId: tenant.tenantId, period: '2026-07',
    status: 'locked', activeRunId: runId,
  })) };
  const calculationLines = { findOne: vi.fn().mockReturnValue(query({
    id: lineId, tenantId: tenant.tenantId, periodId, runId,
    employeeId: 'employee-001', resultHash: original.resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  })) };
  const adjustments = {
    findOne: vi.fn().mockReturnValue(query(null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const runs = { calculateAdjustmentCandidate: vi.fn().mockResolvedValue({
    input: correctedInput, result: corrected, attendanceSnapshotHash: 's'.repeat(43),
  }) };
  const crypto = {
    unprotect: vi.fn().mockReturnValue(original),
    protect: vi.fn().mockReturnValue({
      keyId: 'adjustment-key', iv: 'i'.repeat(16),
      ciphertext: 'c'.repeat(32), authTag: 'a'.repeat(22),
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const approvals = {};
  const strongAuth = {};
  const service = new PayrollAdjustmentService(
    idempotency as never, context, boundary as never,
    approvals as never, strongAuth as never,
    runs as never, crypto as never, outbox as never,
    periods as never, calculationLines as never, adjustments as never,
  );
  return {
    context,
    boundary,
    service,
    idempotency,
    periods,
    calculationLines,
    runs,
    crypto,
    outbox,
    adjustments,
    original,
    corrected,
    correctedInput,
  };
}

function validInput() {
  return {
    periodId,
    originalCalculationLineId: lineId,
    rulePackId,
    rulePackVersion: 1,
    reasonCode: 'RETROACTIVE_SALARY_CHANGE',
    correctedLine: {
      employeeId: 'employee-001',
      compensationProfileId: profileId,
      attendanceSnapshotId: attendanceId,
    },
  };
}

async function prepare(
  store: ReturnType<typeof assemble>,
  input: Parameters<PayrollAdjustmentService['prepare']>[1] = validInput(),
  principal: ActorContext = actor(),
) {
  return store.context.run({ tenant, actor: principal }, () =>
    store.service.prepare('adjustment-helper', input));
}

describe('PayrollAdjustmentService', () => {
  it('专业算薪模式在访问旧周期集合前稳定短路', async () => {
    const boundary = {
      assertLegacy: vi.fn(() => {
        throw new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
      }),
    };
    const store = assemble(boundary);

    await expect(prepare(store)).rejects.toThrow(
      'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
    );
    expect(boundary.assertLegacy).toHaveBeenCalledOnce();
    expect(store.periods.findOne).not.toHaveBeenCalled();
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('从活动锁定工资行与服务端重算结果准备补发差额', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('adjustment-001', {
        periodId, originalCalculationLineId: lineId,
        rulePackId, rulePackVersion: 1,
        reasonCode: 'RETROACTIVE_SALARY_CHANGE',
        correctedLine: {
          employeeId: 'employee-001', compensationProfileId: profileId,
          attendanceSnapshotId: attendanceId,
        },
      }));

    expect(result).toMatchObject({
      period: '2026-07', type: 'supplement', status: 'prepared',
      grossDeltaMinor: 100_000, taxDeltaMinor: 3_000,
      netDeltaMinor: 97_000, payableMinor: 97_000, receivableMinor: 0,
    });
    expect(store.runs.calculateAdjustmentCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ id: periodId, status: 'locked' }),
      rulePackId, 1, expect.objectContaining({ employeeId: 'employee-001' }), session,
    );
    expect(store.adjustments.create).toHaveBeenCalledWith([
      expect.objectContaining({
        employeeId: 'employee-001', preparedBy: 'payroll-adjustment-engine',
        originalCalculationLineId: lineId, status: 'prepared',
      }),
    ], { session });
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event.type).toBe('payroll.adjustment.prepared');
    expect(JSON.stringify(event.data)).not.toContain('employee-001');
  });

  it('普通用户即使持有 Scope 也不能准备工资更正', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: actor('user') }, () =>
      store.service.prepare('adjustment-001', {
        periodId, originalCalculationLineId: lineId,
        rulePackId, rulePackVersion: 1,
        reasonCode: 'RETROACTIVE_SALARY_CHANGE',
        correctedLine: {
          employeeId: 'employee-001', compensationProfileId: profileId,
          attendanceSnapshotId: attendanceId,
        },
      }))).rejects.toMatchObject({ response: {
      code: 'PAYROLL_ADJUSTMENT_SERVICE_REQUIRED',
    } });
    expect(store.runs.calculateAdjustmentCandidate).not.toHaveBeenCalled();
  });

  it('缺少工资调整制备权限时先失败关闭', async () => {
    const store = assemble();
    await expect(prepare(store, validInput(), actor('system_job', [])))
      .rejects.toMatchObject({
        response: { code: 'AUTH_SCOPE_DENIED' },
      });
  });

  it.each([
    { ...validInput(), extra: true },
    { ...validInput(), periodId: 'bad' },
    { ...validInput(), originalCalculationLineId: 'bad' },
    { ...validInput(), rulePackId: 'bad' },
    { ...validInput(), reasonCode: 'bad' },
    { ...validInput(), rulePackVersion: 0 },
    { ...validInput(), rulePackVersion: Number.NaN },
    { ...validInput(), correctedLine: {
      ...validInput().correctedLine,
      extra: true,
    } },
    { ...validInput(), correctedLine: {
      employeeId: '',
      compensationProfileId: profileId,
      attendanceSnapshotId: attendanceId,
    } },
    { ...validInput(), correctedLine: {
      employeeId: 'employee-001',
      compensationProfileId: profileId,
      attendanceSnapshotId: '',
    } },
    { ...validInput(), correctedLine: {
      ...validInput().correctedLine,
      additionalCompensationProfileIds: Array(31).fill('profile-extra'),
    } },
    { ...validInput(), correctedLine: {
      ...validInput().correctedLine,
      additionalCompensationProfileIds: [''],
    } },
    { ...validInput(), correctedLine: {
      ...validInput().correctedLine,
      additionalCompensationProfileIds: [profileId],
    } },
  ])('拒绝非规范工资调整制备输入 %#', async (input) => {
    const store = assemble();
    await expect(prepare(store, input as never)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_INPUT_INVALID' },
    });
  });

  it('接受不重复的附加薪酬档案引用', async () => {
    const store = assemble();
    await expect(prepare(store, {
      ...validInput(),
      correctedLine: {
        ...validInput().correctedLine,
        additionalCompensationProfileIds: ['profile-extra'],
      },
    })).resolves.toMatchObject({ status: 'prepared' });
  });

  it.each([
    [null, 'PAYROLL_ADJUSTMENT_PERIOD_NOT_FOUND'],
    [{
      id: periodId,
      tenantId: tenant.tenantId,
      period: '2026-07',
      status: 'open',
      activeRunId: runId,
    }, 'PAYROLL_ADJUSTMENT_PERIOD_NOT_LOCKED'],
    [{
      id: periodId,
      tenantId: tenant.tenantId,
      period: '2026-07',
      status: 'locked',
      activeRunId: null,
    }, 'PAYROLL_ADJUSTMENT_PERIOD_NOT_LOCKED'],
  ])('拒绝不存在或未锁定的原工资周期 %#', async (period, code) => {
    const store = assemble();
    store.periods.findOne.mockReturnValueOnce(query(period));
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code },
    });
  });

  it('拒绝活动运行中不存在的原工资行', async () => {
    const store = assemble();
    store.calculationLines.findOne.mockReturnValueOnce(query(null));
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_NOT_FOUND' },
    });
  });

  it('拒绝既有活动调整链，但允许已取消链生成递增调整号', async () => {
    const active = assemble();
    active.adjustments.findOne.mockReturnValueOnce(query({
      status: 'prepared',
      adjustmentNumber: 1,
    }));
    await expect(prepare(active)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_ACTIVE_CHAIN_EXISTS' },
    });

    const cancelled = assemble();
    cancelled.adjustments.findOne.mockReturnValueOnce(query({
      status: 'cancelled',
      adjustmentNumber: 1,
    }));
    await prepare(cancelled);
    expect(cancelled.adjustments.create).toHaveBeenCalledWith([
      expect.objectContaining({ adjustmentNumber: 2 }),
    ], { session });
  });

  it('拒绝原工资行控制摘要与密文结果不一致', async () => {
    const store = assemble();
    store.calculationLines.findOne.mockReturnValueOnce(query({
      id: lineId,
      tenantId: tenant.tenantId,
      periodId,
      runId,
      employeeId: 'employee-001',
      resultHash: 'x'.repeat(43),
      dataKeyId: 'key',
      dataIv: 'iv',
      dataCiphertext: 'cipher',
      dataAuthTag: 'tag',
    }));
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_INTEGRITY_FAILED' },
    });
  });

  it('把受保护结构、重复键与领域重算冲突映射为稳定错误', async () => {
    const malformed = assemble();
    malformed.crypto.unprotect.mockReturnValueOnce({});
    await expect(prepare(malformed)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_PROTECTED_DATA_INVALID' },
    });

    const duplicate = assemble();
    duplicate.idempotency.execute.mockRejectedValueOnce({ code: 11000 });
    await expect(prepare(duplicate)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_WRITE_CONFLICT' },
    });

    const unchanged = assemble();
    unchanged.runs.calculateAdjustmentCandidate.mockResolvedValueOnce({
      input: base,
      result: unchanged.original,
      attendanceSnapshotHash: 's'.repeat(43),
    });
    await expect(prepare(unchanged)).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_INPUT_UNCHANGED' },
    });
  });

  it('净额为零但税额变化时建立无需现金结算的税务调整', async () => {
    const store = assemble();
    const correctedInput = {
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
      postTaxDeductionMinor: 97_000,
    };
    store.runs.calculateAdjustmentCandidate.mockResolvedValueOnce({
      input: correctedInput,
      result: calculatePayroll(correctedInput),
      attendanceSnapshotHash: 's'.repeat(43),
    });
    await expect(prepare(store)).resolves.toMatchObject({
      type: 'tax_only',
      cashSettlementStatus: 'not_required',
      taxCorrectionStatus: 'pending',
    });
  });
});
