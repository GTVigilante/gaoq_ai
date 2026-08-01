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
const DIFFERENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const READINESS_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Q1';

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
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollShadowService(
    idempotency as never, context, boundary as never,
    crypto as never, {} as never, outbox as never,
    periods as never, calculationLines as never, cycles as never, differences as never,
    explanations as never, signoffs as never, readiness as never,
  );
  const lines: readonly LegacyShadowPayrollLine[] = [{
    employeeId: 'employee-001', sourceLineId: 'legacy-line-001',
    grossPayMinor: 100_000, withholdingTaxMinor: 1_000,
    netPayMinor: 90_000, resultHash: 'l'.repeat(43),
  }];
  return {
    context, service, periods, calculationLines, cycles, differences, crypto, idempotency,
    outbox, boundary, period, calculationLine, lines,
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
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollShadowService(
    idempotency as never, context, boundary as never,
    {} as never, strongAuth as never, outbox as never,
    periods as never, {} as never, cycles as never, differences as never,
    explanations as never, signoffs as never, readiness as never,
  );
  return {
    context, service, periods, cycles, differences, explanations, signoffs, readiness,
    idempotency, strongAuth, outbox, boundary, cycle, period, previousSignoff, payrollSignoff,
  };
}

function setupExplain(explainedCount = 1) {
  const context = new TenantContextService();
  const cycle = {
    ...setupSign(1).cycle,
    differenceCodes: ['GROSS_AMOUNT_MISMATCH'] as const,
    differenceCount: 1,
    totalAbsoluteDifferenceMinor: 1_000,
  };
  const difference = {
    id: DIFFERENCE_ID,
    cycleId: CYCLE_ID,
    evidenceHash: 'd'.repeat(43),
    code: 'GROSS_AMOUNT_MISMATCH',
  };
  const cycles = { findOne: vi.fn().mockReturnValue(query(() => cycle)) };
  const signoffs = { findOne: vi.fn().mockReturnValue(query(() => null)) };
  const differences = { findOne: vi.fn().mockReturnValue(query(() => difference)) };
  const explanations = {
    create: vi.fn().mockResolvedValue([]),
    countDocuments: vi.fn().mockReturnValue(query(() => explainedCount)),
  };
  const idempotency = {
    execute: vi.fn((
      _namespace: string, _key: string, _payload: unknown,
      operation: (transaction: ClientSession) => Promise<unknown>,
    ) => operation(session)),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollShadowService(
    idempotency as never, context, boundary as never,
    {} as never, {} as never, outbox as never,
    {} as never, {} as never, cycles as never, differences as never,
    explanations as never, signoffs as never, {} as never,
  );
  return {
    context, service, cycles, signoffs, differences, explanations, idempotency, outbox, boundary,
    cycle, difference,
  };
}

function setupRead() {
  const context = new TenantContextService();
  const base = setupSign(1);
  const cycle = {
    ...base.cycle,
    differenceCodes: ['GROSS_AMOUNT_MISMATCH'] as const,
    differenceCount: 1,
    totalAbsoluteDifferenceMinor: 1_000,
  };
  const differenceWithoutHash = {
    employeeId: 'employee-001',
    code: 'GROSS_AMOUNT_MISMATCH' as const,
    erpMinor: 100_000,
    legacyMinor: 99_000,
    deltaMinor: 1_000,
  };
  const evidenceHash = payrollDigest(differenceWithoutHash);
  const difference = {
    id: DIFFERENCE_ID,
    cycleId: CYCLE_ID,
    code: differenceWithoutHash.code,
    evidenceHash,
    dataKeyId: 'payroll-key-001',
    dataIv: 'a'.repeat(16),
    dataCiphertext: 'b'.repeat(32),
    dataAuthTag: 'c'.repeat(22),
  };
  const explanation = {
    differenceId: DIFFERENCE_ID,
    explanationCode: 'LEGACY_RULE_VERSION',
    evidenceId: 'legacy-rule-evidence-001',
  };
  const payrollSignoff = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
    role: 'payroll_owner',
  };
  const financeSignoff = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4S2',
    role: 'finance_owner',
  };
  const readinessRecord = {
    id: READINESS_ID,
    firstCycleId: '01J8ZQK7V0A2M4N6P8R0T2W4C0',
    secondCycleId: CYCLE_ID,
    startPeriod: '2026-06',
    endPeriod: '2026-07',
    evidenceHash: 'r'.repeat(43),
    status: 'eligible' as const,
    version: 1,
  };
  const cycles = { findOne: vi.fn().mockReturnValue(query(() => cycle)) };
  const differences = { find: vi.fn().mockReturnValue(query(() => [difference])) };
  const explanations = {
    countDocuments: vi.fn().mockReturnValue(query(() => 1)),
    find: vi.fn().mockReturnValue(query(() => [explanation])),
  };
  const signoffs = {
    find: vi.fn().mockReturnValue(query(() => [payrollSignoff, financeSignoff])),
  };
  const readiness = {
    findOne: vi.fn((filter: { id?: string }) =>
      query(() => filter.id === READINESS_ID ? readinessRecord : readinessRecord)),
  };
  const crypto = {
    unprotect: vi.fn().mockReturnValue({ ...differenceWithoutHash, evidenceHash }),
  };
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollShadowService(
    {} as never, context, boundary as never,
    crypto as never, {} as never, {} as never,
    {} as never, {} as never, cycles as never, differences as never,
    explanations as never, signoffs as never, readiness as never,
  );
  return {
    context, service, cycles, differences, explanations, signoffs, readiness, crypto, boundary,
    cycle, difference, explanation, readinessRecord,
  };
}

describe('PayrollShadowService', () => {
  it('external 模式覆盖导入、归因、签署及全部只读入口', async () => {
    const failure = new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');

    const imported = setupImport();
    imported.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    const connector: ActorContext = {
      actorType: 'service',
      actorId: 'legacy-connector',
      tenantId: tenant.tenantId,
      roleCodes: [],
      scopes: ['erp:payroll:shadow:import'],
      departmentIds: [],
      traceId: 'trace-shadow-boundary-import',
    };
    await expect(imported.context.run({ tenant, actor: connector }, () =>
      imported.service.importCycle('invalid', {} as never))).rejects.toBe(failure);
    expect(imported.idempotency.execute).not.toHaveBeenCalled();
    expect(imported.periods.findOne).not.toHaveBeenCalled();
    expect(imported.crypto.unprotect).not.toHaveBeenCalled();

    const explained = setupExplain();
    explained.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    const analyst: ActorContext = {
      actorType: 'user',
      actorId: 'payroll-analyst',
      tenantId: tenant.tenantId,
      roleCodes: [],
      scopes: ['erp:payroll:shadow:explain'],
      departmentIds: [],
      traceId: 'trace-shadow-boundary-explain',
    };
    await expect(explained.context.run({ tenant, actor: analyst }, () =>
      explained.service.explainDifference(
        'invalid',
        'invalid',
        'invalid',
        'LEGACY_RULE_VERSION',
        'invalid value',
      ))).rejects.toBe(failure);
    expect(explained.idempotency.execute).not.toHaveBeenCalled();
    expect(explained.cycles.findOne).not.toHaveBeenCalled();

    const signed = setupSign(0, false);
    signed.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    const signer: ActorContext = {
      actorType: 'user',
      actorId: 'independent-payroll',
      tenantId: tenant.tenantId,
      roleCodes: [],
      scopes: ['erp:payroll:shadow:sign_payroll'],
      departmentIds: [],
      traceId: 'trace-shadow-boundary-sign',
    };
    const token = {
      actorType: 'user' as const,
      actorId: signer.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    await expect(signed.context.run({ tenant, actor: signer }, () =>
      signed.service.signCycle(
        'invalid',
        'invalid',
        'invalid',
        token as never,
        'payroll_owner',
      ))).rejects.toBe(failure);
    expect(signed.strongAuth.requireVerifiedEvidence).not.toHaveBeenCalled();
    expect(signed.idempotency.execute).not.toHaveBeenCalled();
    expect(signed.cycles.findOne).not.toHaveBeenCalled();

    const cycle = setupRead();
    cycle.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    const reader: ActorContext = {
      actorType: 'user',
      actorId: 'finance-reader',
      tenantId: tenant.tenantId,
      roleCodes: [],
      scopes: ['erp:payroll:shadow:read'],
      departmentIds: [],
      traceId: 'trace-shadow-boundary-read',
    };
    await expect(cycle.context.run({ tenant, actor: reader }, () =>
      cycle.service.getCycle('invalid'))).rejects.toBe(failure);
    expect(cycle.cycles.findOne).not.toHaveBeenCalled();

    const differences = setupRead();
    differences.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    const differenceReader = {
      ...reader,
      scopes: ['erp:payroll:shadow:difference:read'],
    };
    await expect(differences.context.run({ tenant, actor: differenceReader }, () =>
      differences.service.getDifferences('invalid'))).rejects.toBe(failure);
    expect(differences.cycles.findOne).not.toHaveBeenCalled();
    expect(differences.crypto.unprotect).not.toHaveBeenCalled();

    const readiness = setupRead();
    readiness.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    await expect(readiness.context.run({ tenant, actor: reader }, () =>
      readiness.service.getReadiness('invalid'))).rejects.toBe(failure);
    expect(readiness.readiness.findOne).not.toHaveBeenCalled();

    const unauthorized = setupRead();
    await expect(unauthorized.context.run({
      tenant,
      actor: { ...reader, scopes: [] },
    }, () => unauthorized.service.getCycle('invalid')))
      .rejects.toThrow('缺少影子工资权限');
    expect(unauthorized.boundary.assertLegacy).not.toHaveBeenCalled();
  });

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

  it('薪酬负责人只可签署差异与归因一一对应的证据集', async () => {
    const store = setupSign(1, false);
    store.differences.find.mockReturnValue(query(() => [{
      id: DIFFERENCE_ID,
      evidenceHash: 'd'.repeat(43),
    }]));
    store.explanations.find.mockReturnValue(query(() => [{
      differenceId: DIFFERENCE_ID,
      evidenceHash: 'e'.repeat(43),
      explainedBy: 'payroll-analyst',
    }]));
    const actor: ActorContext = {
      actorType: 'user',
      actorId: 'independent-payroll',
      tenantId: tenant.tenantId,
      roleCodes: ['payroll_shadow_signer'],
      scopes: ['erp:payroll:shadow:sign_payroll'],
      departmentIds: [],
      traceId: 'trace-shadow-explained-sign',
    };
    const token = {
      actorType: 'user' as const,
      actorId: actor.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.signCycle(
        'shadow-sign-explained-key-001',
        CYCLE_ID,
        EVIDENCE_ID,
        token as never,
        'payroll_owner',
      ));
    expect(result).toMatchObject({
      status: 'ready_for_finance_signoff',
      differenceCount: 1,
      unresolvedDifferenceCount: 0,
    });
    expect(store.signoffs.create).toHaveBeenCalledOnce();
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

  it('差异导入只持久化密文并进入待归因状态', async () => {
    const store = setupImport();
    const actor: ActorContext = {
      actorType: 'system_job', actorId: 'legacy-job', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:import'],
      departmentIds: [], traceId: 'trace-shadow-difference',
    };
    const lines: readonly LegacyShadowPayrollLine[] = [{
      ...store.lines[0]!,
      grossPayMinor: 99_000,
      netPayMinor: 89_000,
    }];
    const input = {
      ...store.input,
      sourceManifestHash: shadowPayrollManifestHash({
        period: '2026-07',
        sourceSystem: store.input.sourceSystem,
        sourceExportId: store.input.sourceExportId,
        lines,
      }),
      lines,
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.importCycle('shadow-import-key-002', input));
    expect(result).toMatchObject({
      status: 'needs_explanation',
      differenceCount: 2,
      unresolvedDifferenceCount: 2,
    });
    expect(store.differences.create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.differences.create.mock.calls)).not.toContain('employee-001');
  });

  it('导入拒绝缺少权限和非受信任执行主体', async () => {
    const store = setupImport();
    const noScope: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-shadow-no-scope',
    };
    await expect(store.context.run({ tenant, actor: noScope }, () =>
      store.service.importCycle('shadow-import-key-003', store.input)))
      .rejects.toThrow('缺少影子工资权限');

    const user = {
      ...noScope,
      actorType: 'user' as const,
      actorId: 'payroll-user',
      scopes: ['erp:payroll:shadow:import'],
    };
    await expect(store.context.run({ tenant, actor: user }, () =>
      store.service.importCycle('shadow-import-key-004', store.input)))
      .rejects.toThrow('只允许受信任旧系统连接器导入');
  });

  it.each([
    { periodId: 'invalid' },
    { sourceSystem: '非法 空格' },
    { sourceExportId: '' },
    { sourceObjectEvidenceId: '非法 空格' },
    { sourceSignatureEvidenceId: '非法 空格' },
    { sourceManifestHash: 'invalid' },
    { lines: null },
    { unexpected: true },
  ])('导入拒绝非法引用 %#', async (patch) => {
    const store = setupImport();
    const actor: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:import'],
      departmentIds: [], traceId: 'trace-shadow-invalid-input',
    };
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.importCycle(
        'shadow-import-key-invalid',
        { ...store.input, ...patch } as never,
      ))).rejects.toThrow('影子工资导入引用非法');
  });

  it.each([
    { status: 'open' },
    { activeRunId: null },
    { resultHash: null },
    { employeeCount: null },
    { totalGrossMinor: null },
    { totalTaxMinor: null },
    { totalNetMinor: null },
  ])('导入拒绝未冻结或控制字段缺失的周期 %#', async (patch) => {
    const store = setupImport();
    Object.assign(store.period, patch);
    const actor: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:import'],
      departmentIds: [], traceId: 'trace-shadow-period-invalid',
    };
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.importCycle('shadow-import-key-period-invalid', store.input)))
      .rejects.toThrow('影子比较要求工资运行已锁定或完成对账');
  });

  it('导入对周期、结果行、完整性、控制总额和来源清单失败关闭', async () => {
    const actor: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:import'],
      departmentIds: [], traceId: 'trace-shadow-import-failures',
    };

    const missingPeriod = setupImport();
    missingPeriod.periods.findOne.mockReturnValue(query(() => null));
    await expect(missingPeriod.context.run({ tenant, actor }, () =>
      missingPeriod.service.importCycle('shadow-missing-period', missingPeriod.input)))
      .rejects.toThrow('工资周期不存在');

    const incomplete = setupImport();
    incomplete.calculationLines.find.mockReturnValue(query(() => []));
    await expect(incomplete.context.run({ tenant, actor }, () =>
      incomplete.service.importCycle('shadow-incomplete-lines', incomplete.input)))
      .rejects.toThrow('ERP 工资结果行不完整');

    const corrupt = setupImport();
    corrupt.crypto.unprotect.mockReturnValue({ invalid: true });
    await expect(corrupt.context.run({ tenant, actor }, () =>
      corrupt.service.importCycle('shadow-corrupt-line', corrupt.input)))
      .rejects.toThrow('ERP 工资结果行完整性失败');

    const controlMismatch = setupImport();
    controlMismatch.period.totalGrossMinor = 99_999;
    await expect(controlMismatch.context.run({ tenant, actor }, () =>
      controlMismatch.service.importCycle('shadow-control-mismatch', controlMismatch.input)))
      .rejects.toThrow('ERP 工资控制总额不一致');

    const sourceMismatch = setupImport();
    await expect(sourceMismatch.context.run({ tenant, actor }, () =>
      sourceMismatch.service.importCycle('shadow-source-mismatch', {
        ...sourceMismatch.input,
        sourceManifestHash: 'x'.repeat(43),
      }))).rejects.toThrow();
  });

  it('人工归因形成可审计事件并在全部解释后进入待签署状态', async () => {
    const store = setupExplain();
    const actor: ActorContext = {
      actorType: 'user', actorId: 'payroll-analyst', tenantId: tenant.tenantId,
      roleCodes: ['payroll_shadow_analyst'], scopes: ['erp:payroll:shadow:explain'],
      departmentIds: [], traceId: 'trace-shadow-explain',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.explainDifference(
        'shadow-explain-key-001',
        CYCLE_ID,
        DIFFERENCE_ID,
        'LEGACY_RULE_VERSION',
        'legacy-rule-evidence-001',
      ));
    expect(result).toMatchObject({
      status: 'ready_for_payroll_signoff',
      explainedDifferenceCount: 1,
      unresolvedDifferenceCount: 0,
    });
    expect(store.explanations.create).toHaveBeenCalledOnce();
    const event = JSON.stringify(store.outbox.append.mock.calls);
    expect(event).toContain('payroll.shadow_difference.explained');
    expect(event).toContain('ready_for_payroll_signoff');
  });

  it('部分归因继续保持待解释状态', async () => {
    const store = setupExplain(1);
    store.cycle.differenceCount = 2;
    const actor: ActorContext = {
      actorType: 'user', actorId: 'payroll-analyst', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:explain'],
      departmentIds: [], traceId: 'trace-shadow-partial-explain',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.explainDifference(
        'shadow-explain-key-002',
        CYCLE_ID,
        DIFFERENCE_ID,
        'LEGACY_INPUT_CUTOFF',
        'legacy-cutoff-evidence-001',
      ));
    expect(result.status).toBe('needs_explanation');
    expect(result.unresolvedDifferenceCount).toBe(1);
  });

  it('归因拒绝非人工主体、非法引用、已签周期和缺失差异', async () => {
    const serviceActor: ActorContext = {
      actorType: 'service', actorId: 'legacy-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:explain'],
      departmentIds: [], traceId: 'trace-shadow-explain-service',
    };
    const nonHuman = setupExplain();
    await expect(nonHuman.context.run({ tenant, actor: serviceActor }, () =>
      nonHuman.service.explainDifference(
        'shadow-explain-non-human',
        CYCLE_ID,
        DIFFERENCE_ID,
        'LEGACY_RULE_VERSION',
        'legacy-rule-evidence-001',
      ))).rejects.toThrow('必须由已验证人员执行');

    const actor: ActorContext = {
      ...serviceActor,
      actorType: 'user',
      actorId: 'payroll-analyst',
    };
    for (const args of [
      ['invalid', DIFFERENCE_ID, 'LEGACY_RULE_VERSION', 'evidence-001'],
      [CYCLE_ID, 'invalid', 'LEGACY_RULE_VERSION', 'evidence-001'],
      [CYCLE_ID, DIFFERENCE_ID, 'INVALID', 'evidence-001'],
      [CYCLE_ID, DIFFERENCE_ID, 'LEGACY_RULE_VERSION', '非法 空格'],
    ] as const) {
      const invalid = setupExplain();
      await expect(invalid.context.run({ tenant, actor }, () =>
        invalid.service.explainDifference(
          'shadow-explain-invalid',
          args[0],
          args[1],
          args[2] as never,
          args[3],
        ))).rejects.toThrow('影子差异归因引用非法');
    }

    const signed = setupExplain();
    signed.signoffs.findOne.mockReturnValue(query(() => ({ id: 'signoff-001' })));
    await expect(signed.context.run({ tenant, actor }, () => signed.service.explainDifference(
      'shadow-explain-signed',
      CYCLE_ID,
      DIFFERENCE_ID,
      'LEGACY_RULE_VERSION',
      'evidence-001',
    ))).rejects.toThrow('财务签署后禁止新增差异归因');

    const missingDifference = setupExplain();
    missingDifference.differences.findOne.mockReturnValue(query(() => null));
    await expect(missingDifference.context.run({ tenant, actor }, () =>
      missingDifference.service.explainDifference(
        'shadow-explain-missing',
        CYCLE_ID,
        DIFFERENCE_ID,
        'LEGACY_RULE_VERSION',
        'evidence-001',
      ))).rejects.toThrow('影子工资差异不存在');
  });

  it('签署拒绝缺少权限、身份不一致和非法引用', async () => {
    const baseActor: ActorContext = {
      actorType: 'user', actorId: 'independent-payroll', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-shadow-sign-invalid',
    };
    const token = {
      actorType: 'user' as const,
      actorId: baseActor.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const noScope = setupSign(0, false);
    await expect(noScope.context.run({ tenant, actor: baseActor }, () =>
      noScope.service.signCycle(
        'shadow-sign-no-scope',
        CYCLE_ID,
        EVIDENCE_ID,
        token as never,
        'payroll_owner',
      ))).rejects.toThrow('缺少影子工资权限');

    for (const mismatchedToken of [
      { ...token, actorType: 'service' as const },
      { ...token, tenantId: 'tenant-other' },
      { ...token, actorId: 'actor-other' },
    ]) {
      const invalid = setupSign(0, false);
      const actor = {
        ...baseActor,
        scopes: ['erp:payroll:shadow:sign_payroll'],
      };
      await expect(invalid.context.run({ tenant, actor }, () => invalid.service.signCycle(
        'shadow-sign-identity-invalid',
        CYCLE_ID,
        EVIDENCE_ID,
        mismatchedToken as never,
        'payroll_owner',
      ))).rejects.toThrow('影子周期签署身份上下文非法');
    }

    for (const [cycleId, evidenceId] of ([
      ['invalid', EVIDENCE_ID],
      [CYCLE_ID, 'invalid'],
    ] as const)) {
      const invalid = setupSign(0, false);
      const actor = {
        ...baseActor,
        scopes: ['erp:payroll:shadow:sign_payroll'],
      };
      await expect(invalid.context.run({ tenant, actor }, () => invalid.service.signCycle(
        'shadow-sign-reference-invalid',
        cycleId,
        evidenceId,
        token as never,
        'payroll_owner',
      ))).rejects.toThrow('影子周期签署引用非法');
    }
  });

  it('重复签署返回已有签署状态且不重复写入', async () => {
    const store = setupSign();
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-payroll', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:sign_payroll'],
      departmentIds: [], traceId: 'trace-shadow-sign-replay',
    };
    const token = {
      actorType: 'user' as const,
      actorId: actor.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () => store.service.signCycle(
      'shadow-sign-replay',
      CYCLE_ID,
      EVIDENCE_ID,
      token as never,
      'payroll_owner',
    ));
    expect(result).toMatchObject({
      status: 'ready_for_finance_signoff',
      payrollSignoffId: store.payrollSignoff.id,
    });
    expect(store.signoffs.create).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('财务签署在无前期周期时不生成资格，且正确处理跨年月份', async () => {
    const store = setupSign();
    store.cycle.period = '2026-01';
    store.signoffs.findOne.mockImplementation(
      (filter: { period?: string; role?: string; cycleId?: string }) =>
        query(() => {
          if (filter.period !== undefined) return null;
          if (filter.cycleId === CYCLE_ID && filter.role === 'payroll_owner') {
            return store.payrollSignoff;
          }
          return null;
        }),
    );
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-finance', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:sign_finance'],
      departmentIds: [], traceId: 'trace-shadow-sign-no-previous',
    };
    const token = {
      actorType: 'user' as const,
      actorId: actor.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () => store.service.signCycle(
      'shadow-sign-no-previous',
      CYCLE_ID,
      EVIDENCE_ID,
      token as never,
      'finance_owner',
    ));
    expect(result.cutoverReadinessId).toBeNull();
    expect(store.signoffs.findOne).toHaveBeenCalledWith(expect.objectContaining({
      period: '2025-12',
      role: 'finance_owner',
    }));
  });

  it('财务签署复用已存在的连续周期资格证据', async () => {
    const store = setupSign();
    const existing = {
      id: READINESS_ID,
      firstCycleId: store.previousSignoff.cycleId,
      secondCycleId: CYCLE_ID,
      startPeriod: '2026-06',
      endPeriod: '2026-07',
      evidenceHash: 'r'.repeat(43),
      status: 'eligible' as const,
      version: 1,
    };
    store.readiness.findOne.mockReturnValue(query(() => existing));
    const actor: ActorContext = {
      actorType: 'user', actorId: 'independent-finance', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:sign_finance'],
      departmentIds: [], traceId: 'trace-shadow-existing-readiness',
    };
    const token = {
      actorType: 'user' as const,
      actorId: actor.actorId,
      tenantId: tenant.tenantId,
      sessionId: 'session-001',
    };
    const result = await store.context.run({ tenant, actor }, () => store.service.signCycle(
      'shadow-sign-existing-readiness',
      CYCLE_ID,
      EVIDENCE_ID,
      token as never,
      'finance_owner',
    ));
    expect(result.cutoverReadinessId).toBe(READINESS_ID);
    expect(store.readiness.create).not.toHaveBeenCalled();
  });

  it('只读摘要返回签署和可切换最小投影', async () => {
    const store = setupRead();
    const actor: ActorContext = {
      actorType: 'user', actorId: 'finance-reader', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:read'],
      departmentIds: [], traceId: 'trace-shadow-read',
    };
    const cycle = await store.context.run({ tenant, actor }, () =>
      store.service.getCycle(CYCLE_ID));
    expect(cycle).toMatchObject({
      status: 'signed',
      payrollSignoffId: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
      financeSignoffId: '01J8ZQK7V0A2M4N6P8R0T2W4S2',
      cutoverReadinessId: READINESS_ID,
    });

    const readiness = await store.context.run({ tenant, actor }, () =>
      store.service.getReadiness(READINESS_ID));
    expect(readiness).toEqual(store.readinessRecord);
  });

  it('行级差异只向人工财务角色返回完整性校验后的明文', async () => {
    const store = setupRead();
    const actor: ActorContext = {
      actorType: 'user', actorId: 'finance-reader', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:difference:read'],
      departmentIds: [], traceId: 'trace-shadow-difference-read',
    };
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.getDifferences(CYCLE_ID));
    expect(result).toEqual([{
      id: DIFFERENCE_ID,
      code: 'GROSS_AMOUNT_MISMATCH',
      employeeId: 'employee-001',
      erpMinor: 100_000,
      legacyMinor: 99_000,
      deltaMinor: 1_000,
      evidenceHash: store.difference.evidenceHash,
      explanationCode: 'LEGACY_RULE_VERSION',
      explanationEvidenceId: 'legacy-rule-evidence-001',
    }]);
  });

  it('只读接口拒绝非法标识、非人工读取、缺失记录和损坏差异', async () => {
    const readActor: ActorContext = {
      actorType: 'user', actorId: 'finance-reader', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:payroll:shadow:read'],
      departmentIds: [], traceId: 'trace-shadow-read-invalid',
    };
    const cycleInvalid = setupRead();
    await expect(cycleInvalid.context.run({ tenant, actor: readActor }, () =>
      cycleInvalid.service.getCycle('invalid')))
      .rejects.toThrow('影子周期标识非法');

    const missingCycle = setupRead();
    missingCycle.cycles.findOne.mockReturnValue(query(() => null));
    await expect(missingCycle.context.run({ tenant, actor: readActor }, () =>
      missingCycle.service.getCycle(CYCLE_ID)))
      .rejects.toThrow('影子工资周期不存在');

    const invalidReadiness = setupRead();
    await expect(invalidReadiness.context.run({ tenant, actor: readActor }, () =>
      invalidReadiness.service.getReadiness('invalid')))
      .rejects.toThrow('工资可切换证据标识非法');

    const missingReadiness = setupRead();
    missingReadiness.readiness.findOne.mockReturnValue(query(() => null) as never);
    await expect(missingReadiness.context.run({ tenant, actor: readActor }, () =>
      missingReadiness.service.getReadiness(READINESS_ID)))
      .rejects.toThrow('工资可切换证据不存在');

    const serviceActor: ActorContext = {
      ...readActor,
      actorType: 'service',
      scopes: ['erp:payroll:shadow:difference:read'],
    };
    const nonHuman = setupRead();
    await expect(nonHuman.context.run({ tenant, actor: serviceActor }, () =>
      nonHuman.service.getDifferences(CYCLE_ID)))
      .rejects.toThrow('只允许已验证人员读取');

    const invalidDifferenceId = setupRead();
    const differenceActor = {
      ...readActor,
      scopes: ['erp:payroll:shadow:difference:read'],
    };
    await expect(invalidDifferenceId.context.run({ tenant, actor: differenceActor }, () =>
      invalidDifferenceId.service.getDifferences('invalid')))
      .rejects.toThrow('影子周期标识非法');

    const incomplete = setupRead();
    incomplete.differences.find.mockReturnValue(query(() => []));
    await expect(incomplete.context.run({ tenant, actor: differenceActor }, () =>
      incomplete.service.getDifferences(CYCLE_ID)))
      .rejects.toThrow('影子工资差异集不完整');

    const corrupt = setupRead();
    corrupt.crypto.unprotect.mockReturnValue({
      employeeId: 'employee-001',
      code: 'GROSS_AMOUNT_MISMATCH',
      erpMinor: 100_000,
      legacyMinor: 99_000,
      deltaMinor: 1_000,
      evidenceHash: 'x'.repeat(43),
    });
    await expect(corrupt.context.run({ tenant, actor: differenceActor }, () =>
      corrupt.service.getDifferences(CYCLE_ID)))
      .rejects.toThrow('影子工资差异完整性失败');
  });
});
