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

function actor(actorType: ActorContext['actorType'] = 'system_job'): ActorContext {
  return {
    actorType, actorId: 'payroll-adjustment-engine', tenantId: tenant.tenantId,
    roleCodes: [], scopes: ['erp:payroll:adjustment:prepare'],
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

function assemble() {
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
    idempotency as never, context, approvals as never, strongAuth as never,
    runs as never, crypto as never, outbox as never,
    periods as never, calculationLines as never, adjustments as never,
  );
  return { context, service, runs, crypto, outbox, adjustments };
}

describe('PayrollAdjustmentService', () => {
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
});
