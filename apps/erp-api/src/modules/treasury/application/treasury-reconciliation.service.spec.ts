import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryReconciliationService } from './treasury-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'reconciliation-service', tenantId: tenant.tenantId,
  roleCodes: ['payroll_reconciliation'], scopes: ['erp:payroll:reconciliation:execute'],
  departmentIds: [], traceId: 'trace-reconciliation-001',
};
const session = {} as ClientSession;
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B1';

function query<T>(resolve: () => T | Promise<T>) {
  const value = { session: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()) };
  value.session.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function setup(balanced = true, omitProfiles = false) {
  const context = new TenantContextService();
  const batch = {
    id: BATCH_ID, tenantId: tenant.tenantId,
    payrollPeriodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
    purpose: 'regular', batchSequence: 1, parentBatchId: null, recoverySourceBatchId: null,
    status: 'reconciling', version: 5, lineCount: 2, totalMinor: 1_679_000,
    preparedBy: 'treasury-maker', objectEvidenceId: 'treasury-worm-001',
    bankSubmissionId: 'bank-submission-001', bankSubmissionEvidenceId: 'bank-evidence-001',
    returnHash: 'b'.repeat(43), successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0,
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/batch-001',
    payrollLockedBy: 'payroll-locker', exportApprovedBy: 'treasury-checker',
  };
  const bankReturn = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4N1', tenantId: tenant.tenantId, batchId: BATCH_ID,
    bankSubmissionId: 'bank-submission-001',
    returnHash: 'b'.repeat(43), outcome: 'accepted', signatureVerified: true,
    malwareClean: true, successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0, unknownCount: 0, duplicateCount: 0,
    lineAmountMismatchCount: 0, objectEvidenceId: 'return-worm-001',
    signatureEvidenceId: 'return-signature-001', malwareScanEvidenceId: 'return-malware-001',
    evidenceReferenceType: 'migration_return_evidence',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/return-001',
    receivedAt: new Date('2026-07-22T11:00:00.000Z'),
  };
  const summary = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4C1', periodId: batch.payrollPeriodId,
    payrollRunId: batch.payrollRunId, batchId: BATCH_ID, bankReturnId: bankReturn.id,
    taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    status: balanced ? 'balanced' as const : 'frozen' as const,
    differences: balanced ? [] : ['PAYROLL_TAX_AMOUNT_MISMATCH'],
    evidenceHash: 'e'.repeat(43), employeeCount: 2, bankLineCount: 2,
    totalGrossMinor: 2_000_000, totalNetMinor: 1_679_000,
    bankSubmittedMinor: 1_679_000, bankReturnedMinor: 1_679_000,
    totalTaxableEarningsMinor: 2_000_000, payrollWithholdingTaxMinor: 21_000,
    filedWithholdingTaxMinor: balanced ? 21_000 : 20_000, version: 1,
  };
  const payroll = {
    getForBatch: vi.fn().mockResolvedValue(null),
    reconcile: vi.fn().mockResolvedValue({
      summary, result: { ...summary, balanced },
    }),
  };
  const batches = {
    findOne: vi.fn().mockReturnValue(query(() => batch)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const returns = { findOne: vi.fn().mockReturnValue(query(() => bankReturn)) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const profiles = { findActorIdByEmployee: vi.fn().mockResolvedValue('historical-reconciler') };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<unknown>,
  ) => handler(session)) };
  const boundary = { assertLegacy: vi.fn() };
  const service = new TreasuryReconciliationService(
    idempotency as never, context, boundary as never,
    payroll as never, outbox as never,
    batches as never, returns as never, omitProfiles ? undefined : profiles as never,
  );
  return {
    context, idempotency, service, payroll, batches, returns, outbox,
    profiles, boundary, summary, batch, bankReturn,
  };
}

const migrationPrincipal: ActorContext = {
  actorType: 'service',
  actorId: 'migration-worker',
  tenantId: tenant.tenantId,
  roleCodes: [],
  scopes: [
    'erp:migration:execute',
    'erp:payroll:migration:write',
    'erp:treasury:migration:write',
  ],
  departmentIds: [],
  traceId: 'trace-four-way-migration',
};

function migrationInput(
  store: ReturnType<typeof setup>,
  targetId: string | null = null,
) {
  return {
    targetId,
    batchId: BATCH_ID,
    bankReturnId: store.bankReturn.id,
    taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    reconciledByEmployeeId: 'employee-reconciler',
    expectedBatchVersion: 5,
    expectedPeriodVersion: 6,
    reconciledAt: '2026-07-22T12:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
    evidenceChecksum: 'm'.repeat(43),
  };
}

function runMigration(
  store: ReturnType<typeof setup>,
  key: string,
  input = migrationInput(store),
) {
  return store.context.run({ tenant, actor: migrationPrincipal }, () =>
    store.service.importBalancedFromMigration(key, input));
}

describe('TreasuryReconciliationService', () => {
  it('external 模式在身份授权后、四方事实读取与事务前失败关闭', async () => {
    const failure = new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
    const migration = setup();
    migration.boundary.assertLegacy.mockImplementation(() => { throw failure; });
    const migrationActor: ActorContext = {
      actorType: 'service',
      actorId: 'migration-worker',
      tenantId: tenant.tenantId,
      roleCodes: [],
      scopes: [
        'erp:migration:execute',
        'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ],
      departmentIds: [],
      traceId: 'trace-boundary-migration',
    };
    await expect(migration.context.run({ tenant, actor: migrationActor }, () =>
      migration.service.importBalancedFromMigration(
        'boundary-reconciliation-migration',
        {} as never,
      ))).rejects.toBe(failure);
    expect(migration.idempotency.execute).not.toHaveBeenCalled();
    expect(migration.batches.findOne).not.toHaveBeenCalled();

    const online = setup();
    online.boundary.assertLegacy.mockImplementation(() => { throw failure; });
    await expect(online.context.run({ tenant, actor }, () => online.service.reconcile(
      'boundary-reconciliation',
      BATCH_ID,
      5,
    ))).rejects.toBe(failure);
    expect(online.idempotency.execute).not.toHaveBeenCalled();
    expect(online.batches.findOne).not.toHaveBeenCalled();

    const unauthorized = setup();
    await expect(unauthorized.context.run({
      tenant,
      actor: { ...actor, scopes: [] },
    }, () => unauthorized.service.reconcile(
      'boundary-reconciliation-unauthorized',
      BATCH_ID,
      5,
    ))).rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    expect(unauthorized.boundary.assertLegacy).not.toHaveBeenCalled();
  });

  it('迁移服务重算四方守恒后恢复批次且不发布普通完成事件', async () => {
    const store = setup();
    const migrationActor: ActorContext = {
      actorType: 'service', actorId: 'migration-worker', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [
        'erp:migration:execute', 'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ], departmentIds: [], traceId: 'trace-four-way-migration',
    };
    const result = await store.context.run({ tenant, actor: migrationActor }, () =>
      store.service.importBalancedFromMigration('four-way-migration', {
        targetId: null, batchId: BATCH_ID,
        bankReturnId: store.bankReturn.id,
        taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
        reconciledByEmployeeId: 'employee-reconciler',
        expectedBatchVersion: 5, expectedPeriodVersion: 6,
        reconciledAt: '2026-07-22T12:00:00.000Z',
        migrationEvidenceRef:
          'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
        evidenceChecksum: 'm'.repeat(43),
      }));
    expect(result).toEqual(store.summary);
    expect(store.payroll.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ID, settledMinor: 1_679_000 }),
      expect.objectContaining({ returnId: store.bankReturn.id }),
      'historical-reconciler', session,
      expect.objectContaining({ expectedPeriodVersion: 6 }),
    );
    expect(store.batches.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: {
      status: 'reconciled', version: 6, freezeReason: null,
      updatedAt: new Date('2026-07-22T12:00:00.000Z'),
    } }, { session, runValidators: true, timestamps: false });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'treasury.reconciliation.migrated', version: 6,
    }), session);
  });

  it('相同四方对账迁移重放只复核事实且不重复更新批次', async () => {
    const store = setup();
    store.batch.status = 'reconciled';
    store.batch.version = 6;
    const migrationActor: ActorContext = {
      actorType: 'system_job', actorId: 'migration-replay', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [
        'erp:migration:execute', 'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ], departmentIds: [], traceId: 'trace-four-way-replay',
    };
    const result = await store.context.run({ tenant, actor: migrationActor }, () =>
      store.service.importBalancedFromMigration('four-way-replay', {
        targetId: store.summary.id, batchId: BATCH_ID,
        bankReturnId: store.bankReturn.id, taxFilingId: store.summary.taxFilingId,
        reconciledByEmployeeId: 'employee-reconciler',
        expectedBatchVersion: 5, expectedPeriodVersion: 6,
        reconciledAt: '2026-07-22T12:00:00.000Z',
        migrationEvidenceRef:
          'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
        evidenceChecksum: 'm'.repeat(43),
      }));
    expect(result).toEqual(store.summary);
    expect(store.payroll.reconcile).toHaveBeenCalledOnce();
    expect(store.batches.updateOne).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('迁移输入、依赖、证据、时间、守恒与批次 CAS 均失败关闭', async () => {
    const invalidInput = setup();
    await expect(runMigration(invalidInput, 'migration-invalid-input', {
      ...migrationInput(invalidInput),
      expectedBatchVersion: 4,
    })).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID' },
    });
    expect(invalidInput.idempotency.execute).not.toHaveBeenCalled();

    const missingProfiles = setup(true, true);
    await expect(runMigration(missingProfiles, 'migration-profiles-missing'))
      .rejects.toThrow('四方对账迁移身份依赖未装配');

    const invalidReference = setup();
    invalidReference.bankReturn.signatureVerified = false;
    await expect(runMigration(invalidReference, 'migration-reference-invalid'))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_REFERENCE_INVALID' },
      });

    const invalidTime = setup();
    await expect(runMigration(invalidTime, 'migration-time-invalid', {
      ...migrationInput(invalidTime),
      reconciledAt: '2026-07-22T10:00:00.000Z',
    })).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_TIME_INVALID' },
    });

    const notBalanced = setup(false);
    await expect(runMigration(notBalanced, 'migration-not-balanced'))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_NOT_BALANCED' },
      });

    const writeConflict = setup();
    writeConflict.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(runMigration(writeConflict, 'migration-write-conflict'))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_BATCH_CONFLICT' },
      });
    expect(writeConflict.outbox.append).not.toHaveBeenCalled();
  });

  it('可信服务对账守恒时同步完成代发批次', async () => {
    const store = setup();
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-reconcile-001', BATCH_ID, 5));
    expect(result).toEqual(store.summary);
    expect(store.batches.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant.tenantId, id: BATCH_ID, status: 'reconciling', version: 5,
    }), { $set: {
      status: 'reconciled', version: 6, freezeReason: null,
    } }, { session, runValidators: true });
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      '"differenceCount":0,"status":"reconciled"',
    );
  });

  it('任一四方差异冻结代发批次且保留差异证据', async () => {
    const store = setup(false);
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-reconcile-002', BATCH_ID, 5));
    expect(result.status).toBe('frozen');
    expect(store.batches.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: {
      status: 'frozen', version: 6, freezeReason: 'FOUR_WAY_MISMATCH',
    } }, expect.anything());
  });

  it('在线对账对非法输入、缺失批次、未就绪状态和不可信回盘失败关闭', async () => {
    const invalidInput = setup();
    await expect(invalidInput.context.run({ tenant, actor }, () =>
      invalidInput.service.reconcile(
        'four-way-invalid-input',
        'invalid',
        0,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_INPUT_INVALID' },
    });
    expect(invalidInput.idempotency.execute).not.toHaveBeenCalled();

    const missing = setup();
    missing.batches.findOne.mockReturnValue(query(() => null));
    await expect(missing.context.run({ tenant, actor }, () =>
      missing.service.reconcile(
        'four-way-batch-missing',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'TREASURY_BATCH_NOT_FOUND' },
    });

    const notReady = setup();
    notReady.batch.status = 'submitted';
    await expect(notReady.context.run({ tenant, actor }, () =>
      notReady.service.reconcile(
        'four-way-not-ready',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_BATCH_NOT_READY' },
    });

    const untrusted = setup();
    untrusted.bankReturn.signatureVerified = false;
    await expect(untrusted.context.run({ tenant, actor }, () =>
      untrusted.service.reconcile(
        'four-way-return-untrusted',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_RETURN_NOT_TRUSTED' },
    });
  });

  it('在线重放返回既有对账，批次 CAS 冲突不得发布完成事件', async () => {
    const replay = setup();
    replay.batch.status = 'reconciled';
    replay.batch.version = 6;
    replay.payroll.getForBatch.mockResolvedValueOnce(replay.summary);
    await expect(replay.context.run({ tenant, actor }, () =>
      replay.service.reconcile(
        'four-way-online-replay',
        BATCH_ID,
        5,
      ))).resolves.toEqual(replay.summary);
    expect(replay.payroll.reconcile).not.toHaveBeenCalled();
    expect(replay.batches.updateOne).not.toHaveBeenCalled();

    const conflict = setup();
    conflict.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({ tenant, actor }, () =>
      conflict.service.reconcile(
        'four-way-online-conflict',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_BATCH_WRITE_CONFLICT' },
    });
    expect(conflict.outbox.append).not.toHaveBeenCalled();
  });

  it('结算链拒绝根批次类型、控制量和成功汇总非法', async () => {
    const invalidRoot = setup();
    invalidRoot.batch.purpose = 'recovery';
    await expect(invalidRoot.context.run({ tenant, actor }, () =>
      invalidRoot.service.reconcile(
        'four-way-root-invalid',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_CHAIN_ROOT_INVALID' },
    });

    const invalidControls = setup();
    invalidControls.bankReturn.failedCount = 1;
    await expect(invalidControls.context.run({ tenant, actor }, () =>
      invalidControls.service.reconcile(
        'four-way-controls-invalid',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_CHAIN_EVIDENCE_INVALID' },
    });

    const zeroSuccess = setup();
    zeroSuccess.batch.successfulCount = 0;
    zeroSuccess.batch.successfulMinor = 0;
    zeroSuccess.batch.failedCount = 2;
    zeroSuccess.batch.failedMinor = zeroSuccess.batch.totalMinor;
    zeroSuccess.bankReturn.successfulCount = 0;
    zeroSuccess.bankReturn.successfulMinor = 0;
    zeroSuccess.bankReturn.failedCount = 2;
    zeroSuccess.bankReturn.failedMinor = zeroSuccess.batch.totalMinor;
    await expect(zeroSuccess.context.run({ tenant, actor }, () =>
      zeroSuccess.service.reconcile(
        'four-way-zero-success',
        BATCH_ID,
        5,
      ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_CHAIN_TOTAL_INVALID' },
    });
  });

  it('普通用户即使持有 Scope 也不能执行自动对账', async () => {
    const store = setup();
    const human = { ...actor, actorType: 'user' as const };
    await expect(store.context.run({ tenant, actor: human }, () =>
      store.service.reconcile('four-way-reconcile-human', BATCH_ID, 5)))
      .rejects.toThrow('只允许受信任对账服务');
    expect(store.payroll.reconcile).not.toHaveBeenCalled();
  });

  it('恢复子批次与父批次成功部分形成完整结算链', async () => {
    const store = setup();
    const parentId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
    const child = {
      ...store.batch, purpose: 'recovery', recoverySourceBatchId: parentId,
      lineCount: 1, totalMinor: 839_500, successfulCount: 1, successfulMinor: 839_500,
    };
    const parent = {
      ...store.batch, id: parentId, purpose: 'regular', recoverySourceBatchId: null,
      status: 'frozen', freezeReason: 'PARTIAL_SUCCESS', returnHash: 'p'.repeat(43),
      successfulCount: 1, successfulMinor: 839_500, failedCount: 1, failedMinor: 839_500,
    };
    const childReturn = {
      ...store.bankReturn, successfulCount: 1, successfulMinor: 839_500,
    };
    const parentReturn = {
      ...store.bankReturn, id: '01J8ZQK7V0A2M4N6P8R0T2W4M1', batchId: parentId,
      returnHash: 'p'.repeat(43), outcome: 'frozen', successfulCount: 1,
      successfulMinor: 839_500, failedCount: 1, failedMinor: 839_500,
    };
    store.batches.findOne.mockImplementation((filter: { id?: string }) =>
      query(() => filter.id === parentId ? parent : child));
    store.returns.findOne.mockImplementation((filter: { batchId?: string }) =>
      query(() => filter.batchId === parentId ? parentReturn : childReturn));
    await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-recovery-chain', BATCH_ID, 5));
    const calls = JSON.stringify(store.payroll.reconcile.mock.calls);
    expect(calls).toContain(
      '"lineCount":1,"totalMinor":839500,"settledLineCount":2,"settledMinor":1679000',
    );
    expect(calls).toMatch(/"settlementChainHash":"[A-Za-z0-9_-]{43}"/u);
  });
});
