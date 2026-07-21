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
receivedAt = new Date().toISOString()) {
  const context = new TenantContextService();
  let batch: Record<string, unknown> = {
    id: BATCH_ID, tenantId: tenant.tenantId, payrollPeriodId: 'period-001',
    payrollRunId: 'run-001', format: 'ISO20022_PAIN_001_001_03', fileHash: 'f'.repeat(43),
    lineCount: 1, totalMinor: 839_500, preparedBy: 'maker', payrollLockedBy: 'locker',
    exportApprovedBy: 'checker', strongAuthEvidenceId: 'strong-auth-001',
    objectEvidenceId: 'file-evidence-001', bankSubmissionId: 'bank-submission-001',
    bankSubmissionEvidenceId: 'submission-evidence-001', returnHash: null,
    successfulCount: null, failedCount: null, successfulMinor: null, failedMinor: null,
    freezeReason: null, status: 'submitted', version: 4,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const batches = {
    findOne: vi.fn().mockImplementation(() => query(() => batch)),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown, update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      batch = { ...batch, ...update.$set, updatedAt: new Date() };
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };
  const instruction = {
    id: 'instruction-001', tenantId: tenant.tenantId, batchId: BATCH_ID,
    payrollCalculationLineId: 'payroll-line-001', employeeId: 'employee-001',
    bankAccountId: '01J8ZQK7V0A2M4N6P8R0T2W4A1', status: 'submitted',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  };
  const instructions = {
    find: vi.fn().mockReturnValue(query(() => [instruction])),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const crypto = { protect: vi.fn().mockReturnValue({
    keyId: 'return-key', iv: 'return-iv', ciphertext: 'return-ciphertext',
    authTag: 'return-auth-tag',
  }), unprotect: vi.fn().mockReturnValue({
    instructionId: instruction.id, employeeId: instruction.employeeId,
    bankAccountId: instruction.bankAccountId,
    payrollCalculationLineId: instruction.payrollCalculationLineId,
    payrollResultHash: 'p'.repeat(43), creditorName: '密文内姓名',
    creditorAccount: '6222000000000001', creditorAgentClearingCode: 'CNAPS001',
    amountMinor: 839_500, purposeCode: 'PAYROLL',
  }) };
  const manifest = {
    returnId: RETURN_ID, tenantId: tenant.tenantId, batchId: BATCH_ID,
    bankSubmissionId: 'bank-submission-001', sequence: 1, returnHash: 'r'.repeat(43),
    objectRef: 'worm/treasury/returns/return-001', objectEvidenceId: 'return-object-001',
    signatureEvidenceId: 'signature-001', ...protection,
    malwareScanEvidenceId: 'scan-001', receivedAt, lines,
  };
  const inbox = { claim: vi.fn().mockResolvedValue(manifest) };
  const returns = {
    findOne: vi.fn().mockReturnValue(query(() => null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new TreasuryBankReturnService(
    idempotency as never, context, inbox, crypto as never, outbox as never,
    batches as never, instructions as never, returns as never,
  );
  return { context, batches, instructions, inbox, returns, outbox, service };
}

describe('TreasuryBankReturnService', () => {
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
});
