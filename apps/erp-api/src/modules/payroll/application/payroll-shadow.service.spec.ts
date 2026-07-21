import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  payrollDigest,
  shadowPayrollManifestHash,
  type LegacyShadowPayrollLine,
} from '../domain/index.js';
import { PayrollShadowService } from './payroll-shadow.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const CYCLE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), lean: vi.fn(), sort: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  return value;
}

function protectedData() {
  return {
    keyId: 'payroll-key-001', iv: 'a'.repeat(16),
    ciphertext: 'b'.repeat(32), authTag: 'c'.repeat(22),
  };
}

function setupImport() {
  const context = new TenantContextService();
  const withoutHash = {
    currency: 'CNY' as const, inputHash: 'i'.repeat(43), grossPayMinor: 100_000,
    taxableEarningsMinor: 100_000, withholdingTaxMinor: 1_000, netPayMinor: 90_000,
    cumulativeAfter: {
      taxableIncomeMinor: 100_000, basicDeductionMinor: 5_000,
      socialInsuranceMinor: 4_000, housingFundMinor: 3_000,
      specialAdditionalDeductionMinor: 0, otherDeductionMinor: 0, taxWithheldMinor: 1_000,
    },
    steps: [],
  };
  const resultHash = payrollDigest(withoutHash);
  const result = { ...withoutHash, resultHash };
  const payrollResultHash = payrollDigest([{ employeeId: 'employee-001', resultHash }]);
  const period = {
    id: PERIOD_ID, tenantId: tenant.tenantId, period: '2026-07', status: 'locked',
    activeRunId: RUN_ID, resultHash: payrollResultHash, employeeCount: 1,
    totalGrossMinor: 100_000, totalTaxMinor: 1_000, totalNetMinor: 90_000,
    preparedBy: 'payroll-maker', approvedBy: 'payroll-approver', lockedBy: 'payroll-locker',
  };
  const calculationLine = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4L1', employeeId: 'employee-001', resultHash,
    dataKeyId: 'payroll-key-001', dataIv: 'a'.repeat(16),
    dataCiphertext: 'b'.repeat(32), dataAuthTag: 'c'.repeat(22),
  };
  const periods = { findOne: vi.fn().mockReturnValue(query(() => period)) };
  const calculationLines = { find: vi.fn().mockReturnValue(query(() => [calculationLine])) };
  const cycles = { create: vi.fn().mockResolvedValue([]) };
  const differences = { create: vi.fn().mockResolvedValue([]) };
  const explanations = {};
  const signoffs = {};
  const readiness = {};
  const crypto = {
    unprotect: vi.fn().mockReturnValue(result), protect: vi.fn().mockReturnValue(protectedData()),
  };
  const idempotency = {
    execute: vi.fn((
      _namespace: string, _key: string, _payload: unknown,
      operation: (transaction: ClientSession) => Promise<unknown>,
    ) => operation(session)),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollShadowService(
    idempotency as never, context, crypto as never, {} as never, outbox as never,
    periods as never, calculationLines as never, cycles as never, differences as never,
    explanations as never, signoffs as never, readiness as never,
  );
  const lines: readonly LegacyShadowPayrollLine[] = [{
    employeeId: 'employee-001', sourceLineId: 'legacy-line-001',
    grossPayMinor: 100_000, withholdingTaxMinor: 1_000,
    netPayMinor: 90_000, resultHash: 'l'.repeat(43),
  }];
  return {
    context, service, cycles, differences, outbox, lines,
    input: {
      periodId: PERIOD_ID, sourceSystem: 'legacy-payroll', sourceExportId: 'legacy-export-001',
      sourceObjectEvidenceId: 'legacy-worm-001',
      sourceSignatureEvidenceId: 'legacy-signature-001',
      sourceManifestHash: shadowPayrollManifestHash({
        period: '2026-07', sourceSystem: 'legacy-payroll',
        sourceExportId: 'legacy-export-001', lines,
      }),
      lines,
    },
  };
}

function setupSign(differenceCount = 0, hasPayrollSignoff = true) {
  const context = new TenantContextService();
  const cycle = {
    id: CYCLE_ID, tenantId: tenant.tenantId, periodId: PERIOD_ID, payrollRunId: RUN_ID,
    period: '2026-07', sourceSystem: 'legacy-payroll', sourceManifestHash: 'm'.repeat(43),
    payrollResultHash: 'p'.repeat(43), comparisonHash: 'c'.repeat(43),
    erpEmployeeCount: 1, legacyEmployeeCount: 1,
    erpTotalGrossMinor: 100_000, legacyTotalGrossMinor: 100_000,
    erpTotalTaxMinor: 1_000, legacyTotalTaxMinor: 1_000,
    erpTotalNetMinor: 90_000, legacyTotalNetMinor: 90_000,
    differenceCodes: [], differenceCount, totalAbsoluteDifferenceMinor: 0,
    importedBy: 'legacy-connector', version: 1,
  };
  const period = {
    id: PERIOD_ID, preparedBy: 'payroll-maker', approvedBy: 'payroll-approver',
    lockedBy: 'payroll-locker',
  };
  const previousSignoff = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4S0', cycleId: '01J8ZQK7V0A2M4N6P8R0T2W4C0',
    evidenceHash: 'e'.repeat(43), period: '2026-06',
  };
  const payrollSignoff = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4S1', cycleId: CYCLE_ID,
    evidenceHash: 'p'.repeat(43), period: '2026-07', role: 'payroll_owner',
    signedBy: 'independent-payroll',
  };
  const cycles = { findOne: vi.fn().mockReturnValue(query(() => cycle)) };
  const periods = { findOne: vi.fn().mockReturnValue(query(() => period)) };
  const differences = { find: vi.fn().mockReturnValue(query(() => [])) };
  const explanations = { find: vi.fn().mockReturnValue(query(() => [])) };
  const signoffs = {
    findOne: vi.fn((filter: { cycleId?: string; period?: string; role?: string }) => query(() => {
      if (filter.period === '2026-06') return previousSignoff;
      if (
        hasPayrollSignoff && filter.cycleId === CYCLE_ID && filter.role === 'payroll_owner'
      ) return payrollSignoff;
      return null;
    })),
    find: vi.fn().mockReturnValue(query(() => hasPayrollSignoff ? [payrollSignoff] : [])),
    create: vi.fn().mockResolvedValue([]),
  };
  const readiness = {
    findOne: vi.fn().mockReturnValue(query(() => null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const idempotency = {
    execute: vi.fn((
      _namespace: string, _key: string, _payload: unknown,
      operation: (transaction: ClientSession) => Promise<unknown>,
    ) => operation(session)),
  };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: EVIDENCE_ID, method: 'webauthn_uv',
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollShadowService(
    idempotency as never, context, {} as never, strongAuth as never, outbox as never,
    periods as never, {} as never, cycles as never, differences as never,
    explanations as never, signoffs as never, readiness as never,
  );
  return { context, service, signoffs, readiness, outbox };
}

describe('PayrollShadowService', () => {
  it('受信任连接器仅持久化密文行并形成零差异控制事件', async () => {
    const store = setupImport();
    const actor: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: ['payroll_legacy_connector'], scopes: ['erp:payroll:shadow:import'],
      departmentIds: [], traceId: 'trace-shadow-import',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.importCycle('shadow-import-key-001', store.input));
    expect(result).toMatchObject({
      status: 'ready_for_payroll_signoff', differenceCount: 0, unresolvedDifferenceCount: 0,
    });
    expect(store.differences.create).not.toHaveBeenCalled();
    const persisted = JSON.stringify(store.cycles.create.mock.calls);
    expect(persisted).not.toMatch(/employee-001|legacy-line-001/u);
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toMatch(/employeeId|sourceExportId/u);
  });

  it('连续前一月已签署时生成资格证据，但不执行事实源切换', async () => {
    const store = setupSign();
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-finance', tenantId: tenant.tenantId,
      roleCodes: ['finance_shadow_signer'], scopes: ['erp:payroll:shadow:sign_finance'],
      departmentIds: [], traceId: 'trace-shadow-sign',
    };
    const token = {
      actorType: 'user' as const, actorId: actor.actorId, tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.signCycle(
        'shadow-sign-key-001', CYCLE_ID, EVIDENCE_ID, token as never, 'finance_owner',
      ));
    expect(result.status).toBe('signed');
    expect(result.cutoverReadinessId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.readiness.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.cutover_readiness.eligible',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toMatch(/signedBy|strongAuthEvidenceId/u);
  });

  it('薪酬负责人先签后只进入待财务复签状态', async () => {
    const store = setupSign(0, false);
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-payroll', tenantId: tenant.tenantId,
      roleCodes: ['payroll_shadow_signer'], scopes: ['erp:payroll:shadow:sign_payroll'],
      departmentIds: [], traceId: 'trace-shadow-payroll-sign',
    };
    const token = {
      actorType: 'user' as const, actorId: actor.actorId, tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () => store.service.signCycle(
      'shadow-sign-payroll-key-001', CYCLE_ID, EVIDENCE_ID, token as never, 'payroll_owner',
    ));
    expect(result).toMatchObject({
      status: 'ready_for_finance_signoff', financeSignoffId: null,
      cutoverReadinessId: null,
    });
    expect(result.payrollSignoffId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.readiness.create).not.toHaveBeenCalled();
  });

  it('未解释差异和职责冲突均失败关闭', async () => {
    const unresolved = setupSign(1);
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-finance', tenantId: tenant.tenantId,
      roleCodes: ['finance_shadow_signer'], scopes: ['erp:payroll:shadow:sign_finance'],
      departmentIds: [], traceId: 'trace-shadow-unresolved',
    };
    const token = { actorType: 'user', actorId: actor.actorId, tenantId: tenant.tenantId,
      sessionId: 'session-001' };
    await expect(unresolved.context.run({ tenant, actor }, () => unresolved.service.signCycle(
      'shadow-sign-key-002', CYCLE_ID, EVIDENCE_ID, token as never, 'finance_owner',
    ))).rejects.toThrow('存在未解释差异');

    const missingPayrollSignoff = setupSign(0, false);
    await expect(missingPayrollSignoff.context.run({ tenant, actor }, () =>
      missingPayrollSignoff.service.signCycle(
        'shadow-sign-key-004', CYCLE_ID, EVIDENCE_ID, token as never, 'finance_owner',
      ))).rejects.toThrow('必须先由独立薪酬负责人签署');

    const conflict = setupSign();
    const conflictingActor = { ...actor, actorId: 'payroll-maker' };
    await expect(conflict.context.run({ tenant, actor: conflictingActor }, () =>
      conflict.service.signCycle('shadow-sign-key-003', CYCLE_ID, EVIDENCE_ID, {
        ...token, actorId: 'payroll-maker',
      } as never, 'finance_owner'))).rejects.toThrow('职责未与导入、制单、审批、锁定或归因分离');
  });
});
