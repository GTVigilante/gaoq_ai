import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryBankReturnService } from './treasury-bank-return.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'return-connector', tenantId: tenant.tenantId,
  roleCodes: [], scopes: ['erp:treasury:return:ingest'],
  departmentIds: [], traceId: 'trace-return-001',
};
const session = {} as ClientSession;
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R2';
const MIGRATION_RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F2';
const MIGRATION_EVIDENCE_REF =
  `erp://data-migrations/runs/${MIGRATION_RUN_ID}/attachments/return-001`;

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), sort: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function assemble(lines = [{
  instructionId: 'instruction-001', outcome: 'succeeded' as const,
  amountMinor: 839_500, bankLineReference: 'bank-line-001',
}], protection = { signatureVerified: true, malwareClean: true },
receivedAt = new Date().toISOString(), sequence = 1, supplement = false,
recoveryRoot?: Readonly<Record<string, unknown>>) {
  const context = new TenantContextService();
  let batch: Record<string, unknown> = {
    id: BATCH_ID, tenantId: tenant.tenantId, payrollPeriodId: 'period-001',
    payrollRunId: 'run-001', format: 'ISO20022_PAIN_001_001_03', fileHash: 'f'.repeat(43),
    purpose: recoveryRoot === undefined
      ? supplement ? 'supplement' : 'regular'
      : 'recovery',
    batchSequence: 1,
    parentBatchId: supplement
      ? '01J8ZQK7V0A2M4N6P8R0T2W4P9'
      : recoveryRoot?.id ?? null,
    recoverySourceBatchId: recoveryRoot?.id ?? null,
    adjustmentSourceId: supplement ? '01J8ZQK7V0A2M4N6P8R0T2W4D1' : null,
    adjustmentSourceHash: supplement ? 'a'.repeat(43) : null,
    lineCount: 1, totalMinor: 839_500, preparedBy: 'maker', payrollLockedBy: 'locker',
    exportApprovedBy: 'checker', strongAuthEvidenceId: 'strong-auth-001',
    objectEvidenceId: 'file-evidence-001', bankSubmissionId: 'bank-submission-001',
    bankSubmissionEvidenceId: 'submission-evidence-001', returnHash: null,
    successfulCount: null, failedCount: null, successfulMinor: null, failedMinor: null,
    freezeReason: null, status: 'submitted', version: 4,
    migrationEvidenceRef: 'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/batch-001',
    strongAuthReferenceType: 'migration_export_approval_evidence',
    createdAt: new Date('2026-07-22T09:00:00.000Z'),
    updatedAt: new Date('2026-07-22T11:00:00.000Z'),
  };
  const batches = {
    findOne: vi.fn().mockImplementation((
      filter: { readonly id?: string },
    ) => query(() => filter.id === recoveryRoot?.id ? recoveryRoot : batch)),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown, update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      batch = { ...batch, ...update.$set, updatedAt: update.$set.updatedAt ?? new Date() };
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };
  let instruction: Record<string, unknown> = {
    id: 'instruction-001', tenantId: tenant.tenantId, batchId: BATCH_ID,
    payrollCalculationLineId: 'payroll-line-001', employeeId: 'employee-001',
    bankAccountId: '01J8ZQK7V0A2M4N6P8R0T2W4A1', status: 'submitted',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
    createdAt: new Date('2026-07-22T09:00:00.000Z'),
    updatedAt: new Date('2026-07-22T11:00:00.000Z'),
  };
  const instructions = {
    find: vi.fn().mockReturnValue(query(() => [instruction])),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown, update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      instruction = { ...instruction, ...update.$set,
        updatedAt: update.$set.updatedAt ?? new Date() };
      return Promise.resolve({ modifiedCount: 1 });
    }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const instructionData = {
    instructionId: instruction.id, employeeId: instruction.employeeId,
    bankAccountId: instruction.bankAccountId,
    payrollCalculationLineId: instruction.payrollCalculationLineId,
    payrollResultHash: 'p'.repeat(43), creditorName: '密文内姓名',
    creditorAccount: '6222000000000001', creditorAgentClearingCode: 'CNAPS001',
    amountMinor: 839_500,
    purposeCode: supplement || recoveryRoot !== undefined
      ? 'PAYROLL_ADJUSTMENT'
      : 'PAYROLL',
  };
  const protectedValues = new Map<string, unknown>();
  const crypto = {
    protect: vi.fn((_context: unknown, value: unknown) => {
      protectedValues.set('return-ciphertext', value);
      return {
        keyId: 'return-key', iv: 'return-iv', ciphertext: 'return-ciphertext',
        authTag: 'return-auth-tag',
      };
    }),
    unprotect: vi.fn((cryptoContext: { resourceType: string }, value: { ciphertext: string }) =>
      cryptoContext.resourceType === 'bank_return'
        ? protectedValues.get(value.ciphertext)
        : instructionData),
  };
  const manifest = {
    returnId: RETURN_ID, tenantId: tenant.tenantId, batchId: BATCH_ID,
    bankSubmissionId: 'bank-submission-001', sequence, returnHash: 'r'.repeat(43),
    objectRef: 'worm/treasury/returns/return-001', objectEvidenceId: 'return-object-001',
    signatureEvidenceId: 'signature-001', ...protection,
    malwareScanEvidenceId: 'scan-001', receivedAt, lines,
  };
  const inbox = { claim: vi.fn().mockResolvedValue(manifest) };
  let returnRecord: Record<string, unknown> | null = null;
  const returns = {
    findOne: vi.fn().mockImplementation(() => query(() => returnRecord)),
    create: vi.fn().mockImplementation((documents: readonly Record<string, unknown>[]) => {
      const document = documents[0] ?? {};
      returnRecord = { ...document, createdAt: document.createdAt ?? new Date(),
        updatedAt: document.updatedAt ?? new Date() };
      return Promise.resolve([]);
    }),
  };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const payrollAdjustments = {
    recordSupplementBankReturn: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TreasuryBankReturnService(
    idempotency as never, context, payrollAdjustments as never,
    inbox, crypto as never, outbox as never,
    batches as never, instructions as never, returns as never,
  );
  return {
    context, batches, instructions, inbox, returns,
    outbox, payrollAdjustments, service,
  };
}

function migrationActor(actorType: 'service' | 'user' = 'service'): ActorContext {
  return {
    actorType, actorId: 'migration-worker', tenantId: tenant.tenantId,
    roleCodes: [], scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
    departmentIds: [], traceId: 'trace-return-migration',
  };
}

function migrationInput(targetId: string | null = null) {
  return {
    targetId, batchId: BATCH_ID, expectedBatchVersion: 4,
    expectedBankSubmissionId: 'bank-submission-001',
    lines: [{
      employeeId: 'employee-001', expectedAmountMinor: 839_500,
      bankLineReference: 'legacy-bank-line-001',
    }],
    expectedLineCount: 1, expectedTotalMinor: 839_500,
    signatureVerified: true as const, malwareClean: true as const,
    receivedAt: '2026-07-22T12:00:00.000Z',
    migrationEvidenceRef: MIGRATION_EVIDENCE_REF, evidenceChecksum: 'e'.repeat(43),
  };
}

describe('TreasuryBankReturnService', () => {
  it('迁移全量成功回盘时重建密文清单且不调用外部 Inbox', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration('return-migration', migrationInput()));
    expect(result).toMatchObject({
      version: 1, status: 'reconciling', batchVersion: 5,
      successfulCount: 1, failedCount: 0, successfulMinor: 839_500,
    });
    expect(store.inbox.claim).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'treasury.bank_return.migrated', version: 5,
    }), session);
    const persisted = JSON.stringify([
      store.returns.create.mock.calls, store.outbox.append.mock.calls,
    ]);
    expect(persisted).not.toMatch(/6222000000000001|密文内姓名|employee-001/u);

    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration(
        'return-migration-replay', migrationInput(result.id),
      ))).resolves.toEqual(result);
    expect(store.returns.create).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it('拒绝用户身份执行回盘迁移', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: migrationActor('user') }, () =>
      store.service.importCleanFromMigration('return-migration-denied', migrationInput())))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_MIGRATION_WRITER_DENIED' },
      });
    expect(store.returns.create).not.toHaveBeenCalled();
  });

  it('逐行复核密文金额，完整成功只进入 reconciling', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-success', BATCH_ID, 4));
    expect(result).toMatchObject({
      status: 'reconciling', batchVersion: 5, successfulCount: 1,
      failedCount: 0, unknownCount: 0, duplicateCount: 0, freezeReason: null,
    });
    expect(store.instructions.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'instruction-001', status: 'submitted' }),
      { $set: { status: 'succeeded', bankLineReference: 'bank-line-001' } },
      expect.any(Object),
    );
    const serialized = JSON.stringify([store.returns.create.mock.calls, store.outbox.append.mock.calls, result]);
    expect(serialized).not.toMatch(/6222000000000001|密文内姓名|instruction-001/u);
    expect(store.returns.create).toHaveBeenCalledWith([
      expect.objectContaining({
        dataKeyId: 'return-key', dataCiphertext: 'return-ciphertext',
      }),
    ], expect.any(Object));
  });

  it('补发子批次全额成功时在同一事务回写工资调整现金结算证据', async () => {
    const store = assemble(
      [{
        instructionId: 'instruction-001',
        outcome: 'succeeded',
        amountMinor: 839_500,
        bankLineReference: 'bank-line-001',
      }],
      { signatureVerified: true, malwareClean: true },
      new Date().toISOString(),
      1,
      true,
    );
    await store.context.run({ tenant, actor }, () =>
      store.service.ingest('return-supplement-001', BATCH_ID, 4));
    expect(store.payrollAdjustments.recordSupplementBankReturn).toHaveBeenCalledWith({
      adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
      adjustmentHash: 'a'.repeat(43),
      batchId: BATCH_ID,
      returnId: RETURN_ID,
      successfulMinor: 839_500,
    }, session);
  });

  it('补发恢复子批次全额成功时沿来源链回写同一工资调整', async () => {
    const supplementRoot = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
      tenantId: tenant.tenantId,
      purpose: 'supplement',
      adjustmentSourceId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
      adjustmentSourceHash: 'a'.repeat(43),
      totalMinor: 839_500,
      recoverySourceBatchId: null,
    };
    const store = assemble(
      [{
        instructionId: 'instruction-001',
        outcome: 'succeeded',
        amountMinor: 839_500,
        bankLineReference: 'bank-line-recovery-001',
      }],
      { signatureVerified: true, malwareClean: true },
      new Date().toISOString(),
      1,
      false,
      supplementRoot,
    );
    await store.context.run({ tenant, actor }, () =>
      store.service.ingest('return-supplement-recovery-001', BATCH_ID, 4));
    expect(store.payrollAdjustments.recordSupplementBankReturn).toHaveBeenCalledWith({
      adjustmentId: supplementRoot.adjustmentSourceId,
      adjustmentHash: supplementRoot.adjustmentSourceHash,
      batchId: BATCH_ID,
      returnId: RETURN_ID,
      successfulMinor: 839_500,
    }, session);
  });

  it.each([
    ['未知行', [{ instructionId: 'unknown-line', outcome: 'succeeded' as const, amountMinor: 839_500, bankLineReference: 'bank-line-001' }], { signatureVerified: true, malwareClean: true }, 'UNKNOWN_LINE'],
    ['重复行', [
      { instructionId: 'instruction-001', outcome: 'succeeded' as const, amountMinor: 839_500, bankLineReference: 'bank-line-001' },
      { instructionId: 'instruction-001', outcome: 'succeeded' as const, amountMinor: 839_500, bankLineReference: 'bank-line-002' },
    ], { signatureVerified: true, malwareClean: true }, 'DUPLICATE_LINE'],
    ['行金额错位', [{ instructionId: 'instruction-001', outcome: 'succeeded' as const, amountMinor: 839_499, bankLineReference: 'bank-line-001' }], { signatureVerified: true, malwareClean: true }, 'LINE_AMOUNT_MISMATCH'],
    ['恶意文件', [], { signatureVerified: true, malwareClean: false }, 'MALWARE_DETECTED'],
  ])('%s 必须冻结全批支付指令', async (_label, lines, protection, reason) => {
    const store = assemble(lines, protection);
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.ingest(`treasury-return-${String(_label)}`, BATCH_ID, 4));
    expect(result).toMatchObject({ status: 'frozen', freezeReason: reason });
    expect(store.instructions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ID, status: 'submitted' }),
      { $set: { status: 'frozen' } }, expect.any(Object),
    );
    expect(store.instructions.updateOne).not.toHaveBeenCalled();
  });

  it('拒绝超出时钟偏差窗口的未来回盘', async () => {
    const future = new Date(Date.now() + 5 * 60_000 + 1_000).toISOString();
    const store = assemble(undefined, undefined, future);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-future', BATCH_ID, 4)))
      .rejects.toThrow('银行回盘接收时间非法');
    expect(store.returns.create).not.toHaveBeenCalled();
  });

  it('当前终态回盘契约拒绝把乱序清单当作首份回盘', async () => {
    const store = assemble(undefined, undefined, undefined, 2);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-out-of-order', BATCH_ID, 4)))
      .rejects.toThrow('乱序回盘已拒绝');
    expect(store.returns.create).not.toHaveBeenCalled();
    expect(store.batches.updateOne).not.toHaveBeenCalled();
  });
});
