import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  PayrollReconciliationService,
  type PayrollReconciliationMigrationControl,
} from './payroll-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'reconciliation-service', tenantId: tenant.tenantId,
  roleCodes: ['payroll_reconciliation'], scopes: ['erp:payroll:reconciliation:execute'],
  departmentIds: [], traceId: 'trace-reconciliation-001',
};
const session = {} as ClientSession;
const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B1';
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4N1';

function actorWith(
  scopes: readonly string[],
  actorType: ActorContext['actorType'] = 'service',
  actorId = 'reconciliation-service',
): ActorContext {
  return {
    ...actor,
    actorType,
    actorId,
    scopes: [...scopes],
  };
}

function migrationActor(): ActorContext {
  return actorWith([
    'erp:migration:execute',
    'erp:payroll:migration:write',
    'erp:treasury:migration:write',
  ], 'service', 'migration-worker');
}

function migrationControl(
  overrides: Partial<PayrollReconciliationMigrationControl> = {},
): PayrollReconciliationMigrationControl {
  return {
    targetId: null,
    expectedPeriodVersion: 6,
    expectedTaxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    reconciledAt: '2026-07-22T12:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
    evidenceChecksum: 'm'.repeat(43),
    ...overrides,
  };
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = { session: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()) };
  value.session.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function setup(taxMinor = 21_000) {
  const context = new TenantContextService();
  const period = {
    id: PERIOD_ID, tenantId: tenant.tenantId, period: '2026-07', currency: 'CNY',
    status: 'locked', preparedBy: 'payroll-maker', activeRunId: RUN_ID,
    inputSnapshotHash: 'i'.repeat(43), resultHash: 'a'.repeat(43), employeeCount: 2,
    totalGrossMinor: 2_000_000, totalTaxMinor: 21_000, totalNetMinor: 1_679_000,
    approvalInstanceId: 'approval-001', approvedBy: 'payroll-approver',
    approvalEvidenceId: 'approval-evidence-001', lockedBy: 'payroll-locker',
    strongAuthEvidenceId: 'payroll-lock-evidence-001', disbursementBatchId: null,
    disbursementPreparedBy: null, disbursementExportEvidenceId: null,
    reconciliationEvidenceId: null, reconciledBy: null, version: 6,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-22T08:00:00.000Z'),
  };
  const tax = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', tenantId: tenant.tenantId,
    periodId: PERIOD_ID, payrollRunId: RUN_ID, payrollResultHash: 'a'.repeat(43),
    status: 'submitted', employeeCount: 2, totalTaxableEarningsMinor: 2_000_000,
    totalWithholdingTaxMinor: taxMinor, contentHash: 'c'.repeat(43),
    preparedBy: 'tax-maker', approvedBy: 'tax-approver',
    strongAuthReferenceType: 'migration_tax_approval_evidence',
    taxSubmissionId: 'tax-submission-001', taxSubmissionEvidenceId: 'tax-evidence-001',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/tax-001',
    updatedAt: new Date('2026-07-22T10:00:00.000Z'),
  };
  const periods = {
    findOne: vi.fn().mockReturnValue(query(() => period)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const taxFilings = { findOne: vi.fn().mockReturnValue(query(() => tax)) };
  const reconciliations = {
    findOne: vi.fn().mockReturnValue(query(() => null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollReconciliationService(
    context, boundary as never, outbox as never,
    periods as never, taxFilings as never, reconciliations as never,
  );
  const treasury = {
    batchId: BATCH_ID, payrollPeriodId: PERIOD_ID, payrollRunId: RUN_ID,
    payrollResultHash: 'a'.repeat(43), status: 'reconciling' as const, version: 5,
    lineCount: 2, totalMinor: 1_679_000,
    settledLineCount: 2, settledMinor: 1_679_000, settlementChainHash: 's'.repeat(43),
    preparedBy: 'treasury-maker',
    exportEvidenceId: 'treasury-worm-001', bankSubmissionId: 'bank-submission-001',
    objectEvidenceId: 'treasury-worm-001',
    bankSubmissionEvidenceId: 'bank-evidence-001',
  };
  const bankReturn = {
    returnId: RETURN_ID, batchId: BATCH_ID, returnHash: 'b'.repeat(43),
    outcome: 'accepted' as const, successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0,
    objectEvidenceId: 'return-worm-001', signatureEvidenceId: 'return-signature-001',
    malwareScanEvidenceId: 'return-malware-001',
  };
  return {
    context,
    service,
    period,
    periods,
    tax,
    taxFilings,
    reconciliations,
    outbox,
    boundary,
    treasury,
    bankReturn,
  };
}

function createdReconciliation(store: ReturnType<typeof setup>): Record<string, unknown> {
  const records = store.reconciliations.create.mock.calls[0]?.[0] as unknown as
    | readonly Record<string, unknown>[]
    | undefined;
  const record = records?.[0];
  if (record === undefined) throw new Error('PAYROLL_RECONCILIATION_TEST_RECORD_MISSING');
  return record;
}

describe('PayrollReconciliationService', () => {
  it('external 模式覆盖只读、批次内部读取及在线/迁移对账入口', async () => {
    const failure = new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');

    const read = setup();
    read.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    await expect(read.context.run({
      tenant,
      actor: actorWith(['erp:payroll:reconciliation:read']),
    }, () => read.service.getStatus('invalid'))).rejects.toBe(failure);
    expect(read.reconciliations.findOne).not.toHaveBeenCalled();

    const batch = setup();
    batch.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    await expect(batch.context.run({ tenant, actor }, () =>
      batch.service.getForBatch('invalid', session))).rejects.toBe(failure);
    expect(batch.reconciliations.findOne).not.toHaveBeenCalled();

    const online = setup();
    online.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    await expect(online.context.run({ tenant, actor }, () =>
      online.service.reconcile(
        online.treasury,
        online.bankReturn,
        actor.actorId,
        session,
      ))).rejects.toBe(failure);
    expect(online.reconciliations.findOne).not.toHaveBeenCalled();
    expect(online.periods.findOne).not.toHaveBeenCalled();

    const migration = setup();
    migration.boundary.assertLegacy.mockImplementation(() => {
      throw failure;
    });
    await expect(migration.context.run({ tenant, actor: migrationActor() }, () =>
      migration.service.reconcile(
        migration.treasury,
        migration.bankReturn,
        'migration-worker',
        session,
        {} as never,
      ))).rejects.toBe(failure);
    expect(migration.reconciliations.findOne).not.toHaveBeenCalled();
    expect(migration.periods.findOne).not.toHaveBeenCalled();

    const unauthorized = setup();
    await expect(unauthorized.context.run({
      tenant,
      actor: actorWith([]),
    }, () => unauthorized.service.getStatus('invalid')))
      .rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    expect(unauthorized.boundary.assertLegacy).not.toHaveBeenCalled();
  });

  it('迁移四方重算守恒时冻结历史时间且只发布迁移事件', async () => {
    const store = setup();
    const migrationActor: ActorContext = {
      actorType: 'service', actorId: 'migration-worker', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [
        'erp:migration:execute', 'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ], departmentIds: [], traceId: 'trace-reconciliation-migration',
    };
    const result = await store.context.run({ tenant, actor: migrationActor }, () =>
      store.service.reconcile(
        store.treasury, store.bankReturn, 'historical-reconciler', session, {
          targetId: null, expectedPeriodVersion: 6,
          expectedTaxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
          reconciledAt: '2026-07-22T12:00:00.000Z',
          migrationEvidenceRef:
            'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
          evidenceChecksum: 'm'.repeat(43),
        },
      ));
    expect(result.summary).toMatchObject({ status: 'balanced', differences: [] });
    expect(store.periods.updateOne.mock.calls[0]?.[2]).toEqual({
      session, runValidators: true, timestamps: false,
    });
    expect(store.periods.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { updatedAt: new Date('2026-07-22T12:00:00.000Z') },
    });
    const events = JSON.stringify(store.outbox.append.mock.calls);
    expect(events).toContain('payroll.reconciliation.migrated');
    expect(events).not.toMatch(/payroll\.disbursement\.started|payroll\.reconciliation\.started/u);
    expect(store.reconciliations.create).toHaveBeenCalledWith([
      expect.objectContaining({
        reconciledBy: 'historical-reconciler',
        evidenceReferenceType: 'migration_reconciliation_evidence',
        createdAt: new Date('2026-07-22T12:00:00.000Z'),
      }),
    ], { session });
  });

  it('迁移对账员不得兼任个税制备或批准人', async () => {
    const store = setup();
    const migrationActor: ActorContext = {
      actorType: 'service', actorId: 'migration-worker', tenantId: tenant.tenantId,
      roleCodes: [], scopes: [
        'erp:migration:execute', 'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ], departmentIds: [], traceId: 'trace-reconciliation-role-conflict',
    };
    await expect(store.context.run({ tenant, actor: migrationActor }, () =>
      store.service.reconcile(store.treasury, store.bankReturn, store.tax.preparedBy, session, {
        targetId: null, expectedPeriodVersion: 6,
        expectedTaxFilingId: store.tax.id, reconciledAt: '2026-07-22T12:00:00.000Z',
        migrationEvidenceRef:
          'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F2/attachments/recon-001',
        evidenceChecksum: 'm'.repeat(43),
      }))).rejects.toThrow('历史个税链路、时间或职责分离控制非法');
    expect(store.periods.updateOne).not.toHaveBeenCalled();
  });

  it('四方守恒时连续补齐状态事件并原子完成工资周期', async () => {
    const store = setup();
    const result = await store.context.run({ tenant, actor }, () => store.service.reconcile(
      store.treasury, store.bankReturn, actor.actorId, session,
    ));
    expect(result.summary).toMatchObject({ status: 'balanced', differences: [], version: 1 });
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"status":"reconciled","activeRunId"',
    );
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"reconciledBy":"reconciliation-service","version":9',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.disbursement.started',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.reconciliation.started',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.reconciliation.completed',
    );
    expect(JSON.stringify(store.reconciliations.create.mock.calls))
      .not.toMatch(/employeeId|account|identityEvidence/u);
  });

  it('税额差异固化证据并将工资周期保留在对账态', async () => {
    const store = setup(20_000);
    const result = await store.context.run({ tenant, actor }, () => store.service.reconcile(
      store.treasury, store.bankReturn, actor.actorId, session,
    ));
    expect(result.summary).toMatchObject({
      status: 'frozen', differences: ['PAYROLL_TAX_AMOUNT_MISMATCH'],
    });
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"status":"reconciling","activeRunId"',
    );
    expect(JSON.stringify(store.outbox.append.mock.lastCall)).toContain(
      '"differenceCount":1,"status":"frozen"',
    );
  });

  it('读取对账状态强制只读权限、合法标识和证据一致性', async () => {
    const denied = setup();
    await expect(denied.context.run({ tenant, actor }, () =>
      denied.service.getStatus(PERIOD_ID),
    )).rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });

    const invalid = setup();
    await expect(invalid.context.run({
      tenant,
      actor: actorWith(['erp:payroll:reconciliation:read']),
    }, () => invalid.service.getStatus('bad-id'))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_ID_INVALID' },
    });
    expect(invalid.reconciliations.findOne).not.toHaveBeenCalled();

    const missing = setup();
    await expect(missing.context.run({
      tenant,
      actor: actorWith(['erp:payroll:reconciliation:read']),
    }, () => missing.service.getStatus(PERIOD_ID))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_NOT_FOUND' },
    });

    const baseline = setup();
    await baseline.context.run({ tenant, actor }, () => baseline.service.reconcile(
      baseline.treasury,
      baseline.bankReturn,
      actor.actorId,
      session,
    ));
    const record = createdReconciliation(baseline);
    const found = setup();
    found.reconciliations.findOne.mockReturnValue(query(() => record));
    await expect(found.context.run({
      tenant,
      actor: actorWith(['erp:payroll:reconciliation:read']),
    }, () => found.service.getStatus(
      record.id as string,
    ))).resolves.toMatchObject({
      status: 'balanced',
      differences: [],
      batchId: BATCH_ID,
    });
  });

  it('按代发批次查询复用可信执行权限并支持空结果', async () => {
    const denied = setup();
    await expect(denied.context.run({
      tenant,
      actor: actorWith([]),
    }, () => denied.service.getForBatch(BATCH_ID, session))).rejects.toMatchObject({
      response: { code: 'AUTH_SCOPE_DENIED' },
    });

    const empty = setup();
    await expect(empty.context.run({ tenant, actor }, () =>
      empty.service.getForBatch(BATCH_ID, session),
    )).resolves.toBeNull();

    const baseline = setup();
    await baseline.context.run({ tenant, actor }, () => baseline.service.reconcile(
      baseline.treasury,
      baseline.bankReturn,
      actor.actorId,
      session,
    ));
    const record = createdReconciliation(baseline);
    const found = setup();
    found.reconciliations.findOne.mockReturnValue(query(() => record));
    await expect(found.context.run({ tenant, actor }, () =>
      found.service.getForBatch(BATCH_ID, session),
    )).resolves.toMatchObject({ batchId: BATCH_ID, status: 'balanced' });
  });

  it('在线对账拒绝缺失权限、非服务身份和冒用对账员', async () => {
    const cases = [
      {
        trustedActor: actorWith([]),
        reconciledBy: 'reconciliation-service',
        code: 'AUTH_SCOPE_DENIED',
      },
      {
        trustedActor: actorWith(['erp:payroll:reconciliation:execute'], 'user'),
        reconciledBy: 'reconciliation-service',
        code: 'PAYROLL_RECONCILIATION_IDENTITY_INVALID',
      },
      {
        trustedActor: actorWith(
          ['erp:payroll:reconciliation:execute'],
          'service',
          'reconciliation-service',
        ),
        reconciledBy: 'another-service',
        code: 'PAYROLL_RECONCILIATION_IDENTITY_INVALID',
      },
    ];
    for (const item of cases) {
      const store = setup();
      await expect(store.context.run({ tenant, actor: item.trustedActor }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          item.reconciledBy,
          session,
        ),
      )).rejects.toMatchObject({ response: { code: item.code } });
      expect(store.periods.findOne).not.toHaveBeenCalled();
    }
  });

  it('迁移对账强制三项权限、服务身份与严格控制封套', async () => {
    const deniedActors = [
      actorWith([
        'erp:migration:execute',
        'erp:payroll:migration:write',
        'erp:treasury:migration:write',
      ], 'user'),
      actorWith(['erp:payroll:migration:write', 'erp:treasury:migration:write']),
      actorWith(['erp:migration:execute', 'erp:treasury:migration:write']),
      actorWith(['erp:migration:execute', 'erp:payroll:migration:write']),
    ];
    for (const deniedActor of deniedActors) {
      const store = setup();
      await expect(store.context.run({ tenant, actor: deniedActor }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          'historical-reconciler',
          session,
          migrationControl(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_WRITER_DENIED' },
      });
    }

    const invalidControls: PayrollReconciliationMigrationControl[] = [
      migrationControl({ targetId: 'bad-id' }),
      migrationControl({ expectedPeriodVersion: 5 }),
      migrationControl({ expectedPeriodVersion: 6.5 }),
      migrationControl({ expectedTaxFilingId: 'bad-id' }),
      migrationControl({ migrationEvidenceRef: 'attachment-001' }),
      migrationControl({ evidenceChecksum: 'short' }),
      migrationControl({ reconciledAt: 'not-an-instant' }),
      migrationControl({ reconciledAt: '2026-07-22T12:00:00Z' }),
      migrationControl({ reconciledAt: '2999-01-01T00:00:00.000Z' }),
    ];
    for (const control of invalidControls) {
      const store = setup();
      await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          'historical-reconciler',
          session,
          control,
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID' },
      });
    }

    const extraField = setup();
    await expect(extraField.context.run({ tenant, actor: migrationActor() }, () =>
      extraField.service.reconcile(
        extraField.treasury,
        extraField.bankReturn,
        'historical-reconciler',
        session,
        { ...migrationControl(), unexpected: true } as PayrollReconciliationMigrationControl,
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID' },
    });
  });

  it('工资周期缺失或任一锁定控制量为空时失败关闭', async () => {
    const invalidPeriods = [
      null,
      { activeRunId: null },
      { resultHash: null },
      { employeeCount: null },
      { totalGrossMinor: null },
      { totalNetMinor: null },
      { totalTaxMinor: null },
    ];
    for (const mutation of invalidPeriods) {
      const store = setup();
      const candidate = mutation === null ? null : { ...store.period, ...mutation };
      store.periods.findOne.mockReturnValue(query(() => candidate));
      await expect(store.context.run({ tenant, actor }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          actor.actorId,
          session,
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_PERIOD_NOT_READY' },
      });
      expect(store.taxFilings.findOne).not.toHaveBeenCalled();
    }
  });

  it('个税申报缺失、未提交、缺回执或迁移目标不一致时失败关闭', async () => {
    const invalidTaxes = [
      null,
      { status: 'prepared' },
      { taxSubmissionId: null },
      { taxSubmissionEvidenceId: null },
    ];
    for (const mutation of invalidTaxes) {
      const store = setup();
      const candidate = mutation === null ? null : { ...store.tax, ...mutation };
      store.taxFilings.findOne.mockReturnValue(query(() => candidate));
      await expect(store.context.run({ tenant, actor }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          actor.actorId,
          session,
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_TAX_NOT_SUBMITTED' },
      });
    }

    const migrationMismatch = setup();
    await expect(migrationMismatch.context.run({ tenant, actor: migrationActor() }, () =>
      migrationMismatch.service.reconcile(
        migrationMismatch.treasury,
        migrationMismatch.bankReturn,
        'historical-reconciler',
        session,
        migrationControl({
          expectedTaxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F9',
        }),
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_TAX_NOT_SUBMITTED' },
    });
  });

  it('迁移个税链强制 WORM 来源、历史时间和职责分离', async () => {
    const mutations = [
      { migrationEvidenceRef: null },
      { strongAuthReferenceType: 'webauthn_assertion' },
      { updatedAt: new Date('2026-07-22T13:00:00.000Z') },
      { preparedBy: 'historical-reconciler' },
      { approvedBy: 'historical-reconciler' },
    ];
    for (const mutation of mutations) {
      const store = setup();
      store.taxFilings.findOne.mockReturnValue(query(() => ({ ...store.tax, ...mutation })));
      await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          'historical-reconciler',
          session,
          migrationControl(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_TAX_INVALID' },
      });
      expect(store.periods.updateOne).not.toHaveBeenCalled();
    }
  });

  it('在线重复请求返回既有对账且不重复推进周期', async () => {
    const baseline = setup();
    const first = await baseline.context.run({ tenant, actor }, () =>
      baseline.service.reconcile(
        baseline.treasury,
        baseline.bankReturn,
        actor.actorId,
        session,
      ));
    const record = createdReconciliation(baseline);
    const replay = setup();
    replay.reconciliations.findOne.mockReturnValue(query(() => record));
    await expect(replay.context.run({ tenant, actor }, () =>
      replay.service.reconcile(
        replay.treasury,
        replay.bankReturn,
        actor.actorId,
        session,
      ),
    )).resolves.toEqual(first);
    expect(replay.periods.findOne).not.toHaveBeenCalled();
    expect(replay.reconciliations.create).not.toHaveBeenCalled();
  });

  it('Treasury、银行回盘、工资和个税引用不一致映射稳定差异码', async () => {
    const store = setup();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.reconcile(
        store.treasury,
        { ...store.bankReturn, batchId: 'batch-other' },
        actor.actorId,
        session,
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_INPUT_INVALID' },
    });
    expect(store.reconciliations.create).not.toHaveBeenCalled();
  });

  it('迁移重算存在任何差异时禁止恢复为已对账', async () => {
    const store = setup(20_000);
    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.reconcile(
        store.treasury,
        store.bankReturn,
        'historical-reconciler',
        session,
        migrationControl(),
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_NOT_BALANCED' },
    });
    expect(store.periods.updateOne).not.toHaveBeenCalled();
  });

  it('迁移新建要求工资周期保持锁定、精确版本且时间不晚于快照', async () => {
    const mutations = [
      { status: 'disbursing' },
      { version: 5 },
      { updatedAt: new Date('2026-07-22T13:00:00.000Z') },
    ];
    for (const mutation of mutations) {
      const store = setup();
      store.periods.findOne.mockReturnValue(query(() => ({ ...store.period, ...mutation })));
      await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
        store.service.reconcile(
          store.treasury,
          store.bankReturn,
          'historical-reconciler',
          session,
          migrationControl(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_PERIOD_INVALID' },
      });
      expect(store.periods.updateOne).not.toHaveBeenCalled();
    }
  });

  it('周期状态写入竞争、对账唯一键竞争和未知存储异常分别失败关闭', async () => {
    const periodConflict = setup();
    periodConflict.periods.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(periodConflict.context.run({ tenant, actor }, () =>
      periodConflict.service.reconcile(
        periodConflict.treasury,
        periodConflict.bankReturn,
        actor.actorId,
        session,
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_PERIOD_WRITE_CONFLICT' },
    });
    expect(periodConflict.reconciliations.create).not.toHaveBeenCalled();

    const duplicate = setup();
    duplicate.reconciliations.create.mockRejectedValue({ code: 11_000 });
    await expect(duplicate.context.run({ tenant, actor }, () =>
      duplicate.service.reconcile(
        duplicate.treasury,
        duplicate.bankReturn,
        actor.actorId,
        session,
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECONCILIATION_ALREADY_EXISTS' },
    });

    for (const error of [new Error('MONGO_UNAVAILABLE'), null, { code: 42 }]) {
      const failed = setup();
      failed.reconciliations.create.mockRejectedValue(error);
      await expect(failed.context.run({ tenant, actor }, () =>
        failed.service.reconcile(
          failed.treasury,
          failed.bankReturn,
          actor.actorId,
          session,
        ),
      )).rejects.toBe(error);
    }
  });

  it('迁移既有四方对账只在全部聚合、税务和 WORM 事实一致时收敛', async () => {
    const baseline = setup();
    const control = migrationControl();
    await baseline.context.run({ tenant, actor: migrationActor() }, () =>
      baseline.service.reconcile(
        baseline.treasury,
        baseline.bankReturn,
        'historical-reconciler',
        session,
        control,
      ));
    const record = createdReconciliation(baseline);
    const periodUpdate = baseline.periods.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Record<string, unknown>;
    };

    const exact = setup();
    exact.reconciliations.findOne.mockReturnValue(query(() => record));
    const replayPeriod = { ...exact.period, ...periodUpdate.$set };
    exact.periods.findOne.mockReturnValue(query(() => replayPeriod));
    await expect(exact.context.run({ tenant, actor: migrationActor() }, () =>
      exact.service.reconcile(
        exact.treasury,
        exact.bankReturn,
        'historical-reconciler',
        session,
        migrationControl({ targetId: record.id as string }),
      ),
    )).resolves.toMatchObject({
      summary: { status: 'balanced', id: record.id },
      result: { balanced: true },
    });
    expect(exact.periods.updateOne).not.toHaveBeenCalled();
    expect(exact.reconciliations.create).not.toHaveBeenCalled();

    const recordMutations: Record<string, unknown>[] = [
      { periodId: 'period-other' },
      { payrollRunId: 'run-other' },
      { payrollResultHash: 'z'.repeat(43) },
      { batchId: 'batch-other' },
      { bankReturnId: 'return-other' },
      { returnHash: 'z'.repeat(43) },
      { bankSubmissionId: 'submission-other' },
      { disbursementObjectEvidenceId: 'object-other' },
      { bankSubmissionEvidenceId: 'evidence-other' },
      { bankReturnObjectEvidenceId: 'return-object-other' },
      { signatureEvidenceId: 'signature-other' },
      { malwareScanEvidenceId: 'malware-other' },
      { taxFilingId: 'tax-other' },
      { taxSubmissionId: 'tax-submission-other' },
      { taxSubmissionEvidenceId: 'tax-evidence-other' },
      { taxContentHash: 'z'.repeat(43) },
      { settlementChainHash: 'z'.repeat(43) },
      { employeeCount: 3 },
      { bankLineCount: 3 },
      { totalGrossMinor: 1 },
      { totalNetMinor: 1 },
      { bankSubmittedMinor: 1 },
      { bankReturnedMinor: 1 },
      { totalTaxableEarningsMinor: 1 },
      { payrollWithholdingTaxMinor: 1 },
      { filedWithholdingTaxMinor: 1 },
      { differences: ['PAYROLL_BANK_AMOUNT_MISMATCH'] },
      { evidenceHash: 'z'.repeat(43) },
      { reconciledBy: 'another-reconciler' },
      { status: 'frozen' },
      { version: 2 },
      { evidenceReferenceType: 'online_reconciliation' },
      { migrationEvidenceRef: 'other-ref' },
      { migrationEvidenceChecksum: 'z'.repeat(43) },
      { createdAt: new Date('2026-07-22T11:00:00.000Z') },
      { updatedAt: new Date('2026-07-22T11:00:00.000Z') },
    ];
    for (const mutation of recordMutations) {
      const conflict = setup();
      conflict.reconciliations.findOne.mockReturnValue(query(() => ({
        ...record,
        ...mutation,
      })));
      conflict.periods.findOne.mockReturnValue(query(() => replayPeriod));
      await expect(conflict.context.run({ tenant, actor: migrationActor() }, () =>
        conflict.service.reconcile(
          conflict.treasury,
          conflict.bankReturn,
          'historical-reconciler',
          session,
          migrationControl({ targetId: record.id as string }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_MIGRATION_IMMUTABLE' },
      });
    }
  });

  it('差异证据拒绝重复、未知编码及状态与差异不一致', async () => {
    const baseline = setup(20_000);
    await baseline.context.run({ tenant, actor }, () => baseline.service.reconcile(
      baseline.treasury,
      baseline.bankReturn,
      actor.actorId,
      session,
    ));
    const frozenRecord = createdReconciliation(baseline);
    for (const mutation of [
      {
        differences: [
          'PAYROLL_TAX_AMOUNT_MISMATCH',
          'PAYROLL_TAX_AMOUNT_MISMATCH',
        ],
      },
      { differences: ['UNKNOWN_DIFFERENCE'] },
      { status: 'balanced', differences: ['PAYROLL_TAX_AMOUNT_MISMATCH'] },
      { status: 'frozen', differences: [] },
    ]) {
      const store = setup();
      store.reconciliations.findOne.mockReturnValue(query(() => ({
        ...frozenRecord,
        ...mutation,
      })));
      await expect(store.context.run({
        tenant,
        actor: actorWith(['erp:payroll:reconciliation:read']),
      }, () => store.service.getStatus(
        frozenRecord.id as string,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_RECONCILIATION_EVIDENCE_INVALID' },
      });
    }
  });
});
