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

interface BankReturnLineFixture {
  readonly instructionId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly amountMinor: number;
  readonly bankLineReference: string;
}

function assemble(lines: readonly BankReturnLineFixture[] = [{
  instructionId: 'instruction-001', outcome: 'succeeded' as const,
  amountMinor: 839_500, bankLineReference: 'bank-line-001',
}], protection = { signatureVerified: true, malwareClean: true },
receivedAt = new Date().toISOString(), sequence = 1) {
  const context = new TenantContextService();
  let batch: Record<string, unknown> | null = {
    id: BATCH_ID, tenantId: tenant.tenantId, payrollPeriodId: 'period-001',
    payrollRunId: 'run-001', format: 'ISO20022_PAIN_001_001_03', fileHash: 'f'.repeat(43),
    purpose: 'regular', batchSequence: 1, parentBatchId: null, recoverySourceBatchId: null,
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
    findOne: vi.fn().mockImplementation(() => query(() => batch)),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown, update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      batch = { ...(batch ?? {}), ...update.$set,
        updatedAt: update.$set.updatedAt ?? new Date() };
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
  let instructionData: Record<string, unknown> = {
    instructionId: instruction.id, employeeId: instruction.employeeId,
    bankAccountId: instruction.bankAccountId,
    payrollCalculationLineId: instruction.payrollCalculationLineId,
    payrollResultHash: 'p'.repeat(43), creditorName: '密文内姓名',
    creditorAccount: '6222000000000001', creditorAgentClearingCode: 'CNAPS001',
    amountMinor: 839_500, purposeCode: 'PAYROLL',
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
  const service = new TreasuryBankReturnService(
    idempotency as never, context, inbox, crypto as never, outbox as never,
    batches as never, instructions as never, returns as never,
  );
  return {
    context, batches, instructions, inbox, crypto, manifest, returns, outbox, service,
    getBatch: () => batch,
    setBatch: (value: Record<string, unknown> | null) => { batch = value; },
    mutateBatch: (value: Readonly<Record<string, unknown>>) => {
      batch = batch === null ? null : { ...batch, ...value };
    },
    getInstruction: () => instruction,
    mutateInstruction: (value: Readonly<Record<string, unknown>>) => {
      instruction = { ...instruction, ...value };
    },
    setInstructionData: (value: Record<string, unknown>) => { instructionData = value; },
    getInstructionData: () => instructionData,
    getReturnRecord: () => returnRecord,
    setReturnRecord: (value: Record<string, unknown> | null) => { returnRecord = value; },
    mutateReturnRecord: (value: Readonly<Record<string, unknown>>) => {
      returnRecord = returnRecord === null ? null : { ...returnRecord, ...value };
    },
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

  it.each([
    ['未知字段', { ...migrationInput(), unexpected: true }],
    ['非标准时间', { ...migrationInput(), receivedAt: '2026-07-22 12:00:00' }],
    ['重复员工', {
      ...migrationInput(),
      lines: [
        migrationInput().lines[0]!,
        { ...migrationInput().lines[0]!, bankLineReference: 'legacy-bank-line-002' },
      ],
      expectedLineCount: 2,
    }],
  ])('拒绝迁移控制信息：%s', async (_label, input) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration(`return-migration-${_label}`, input)))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_MIGRATION_INPUT_INVALID' },
      });
    expect(store.returns.create).not.toHaveBeenCalled();
  });

  it.each([
    ['支付指令缺失', (store: ReturnType<typeof assemble>) => {
      store.instructions.find.mockReturnValue(query(() => []));
    }],
    ['密文绑定错位', (store: ReturnType<typeof assemble>) => {
      store.setInstructionData({ ...store.getInstructionData(), instructionId: 'instruction-other' });
    }],
    ['控制总额不一致', (_store: ReturnType<typeof assemble>, input: ReturnType<typeof migrationInput>) => {
      input.expectedTotalMinor += 1;
    }],
  ])('迁移遇到%s时拒绝覆盖既有事实', async (
    _label, arrange, input = migrationInput(),
  ) => {
    const store = assemble();
    arrange(store, input);
    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration(`return-migration-immutable-${_label}`, input)))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_MIGRATION_IMMUTABLE' },
      });
    expect(store.returns.create).not.toHaveBeenCalled();
  });

  it('拒绝迁移不处于唯一可写状态的批次', async () => {
    const store = assemble();
    store.mutateBatch({ status: 'reconciling' });
    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration('return-migration-state', migrationInput())))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_MIGRATION_BATCH_INVALID' },
      });
    expect(store.returns.create).not.toHaveBeenCalled();
  });

  it.each([
    ['批次', (store: ReturnType<typeof assemble>) => {
      store.batches.updateOne.mockResolvedValue({ modifiedCount: 0 });
    }, 'TREASURY_BANK_RETURN_MIGRATION_WRITE_CONFLICT'],
    ['支付行', (store: ReturnType<typeof assemble>) => {
      store.instructions.updateOne.mockResolvedValue({ modifiedCount: 0 });
    }, 'TREASURY_BANK_RETURN_MIGRATION_LINE_CONFLICT'],
  ])('迁移%s写入发生并发冲突时失败关闭', async (_label, arrange, code) => {
    const store = assemble();
    arrange(store);
    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importCleanFromMigration(`return-migration-conflict-${_label}`, migrationInput())))
      .rejects.toMatchObject({ response: { code } });
  });

  it('拒绝缺失目标或事实漂移的迁移重放', async () => {
    const missing = assemble();
    await expect(missing.context.run({ tenant, actor: migrationActor() }, () =>
      missing.service.importCleanFromMigration(
        'return-migration-missing', migrationInput(RETURN_ID),
      ))).rejects.toMatchObject({
      response: { code: 'TREASURY_BANK_RETURN_MIGRATION_IMMUTABLE' },
    });

    const drifted = assemble();
    const result = await drifted.context.run({ tenant, actor: migrationActor() }, () =>
      drifted.service.importCleanFromMigration('return-migration-first', migrationInput()));
    drifted.mutateReturnRecord({ migrationEvidenceChecksum: 'x'.repeat(43) });
    await expect(drifted.context.run({ tenant, actor: migrationActor() }, () =>
      drifted.service.importCleanFromMigration(
        'return-migration-drifted', migrationInput(result.id),
      ))).rejects.toMatchObject({
      response: { code: 'TREASURY_BANK_RETURN_MIGRATION_IMMUTABLE' },
    });
  });

  it.each([
    ['权限范围缺失', { ...actor, scopes: [] }, 'AUTH_SCOPE_DENIED'],
    ['交互式用户', { ...actor, actorType: 'user' as const },
      'TREASURY_BANK_RETURN_SERVICE_REQUIRED'],
  ])('拒绝%s接收银行回盘', async (_label, deniedActor, code) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: deniedActor }, () =>
      store.service.ingest(`treasury-return-denied-${_label}`, BATCH_ID, 4)))
      .rejects.toMatchObject({ response: { code } });
    expect(store.inbox.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['非法批次号', 'bad/id', 4],
    ['非正版本', BATCH_ID, 0],
    ['非整数版本', BATCH_ID, 1.5],
  ])('拒绝%s', async (_label, batchId, version) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest(`treasury-return-invalid-${_label}`, batchId, version)))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_INPUT_INVALID' },
      });
    expect(store.batches.findOne).not.toHaveBeenCalled();
  });

  it('批次不存在时失败关闭', async () => {
    const store = assemble();
    store.setBatch(null);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-missing', BATCH_ID, 4)))
      .rejects.toMatchObject({ response: { code: 'TREASURY_BATCH_NOT_FOUND' } });
    expect(store.inbox.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['非待回盘状态', { status: 'draft' }],
    ['批次版本漂移', { version: 5 }],
    ['提交证据缺失', { bankSubmissionId: null }],
  ])('拒绝%s的批次', async (_label, mutation) => {
    const store = assemble();
    store.mutateBatch(mutation);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest(`treasury-return-state-${_label}`, BATCH_ID, 4)))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_BANK_RETURN_STATE_INVALID' },
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

    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-success-replay', BATCH_ID, 4)))
      .resolves.toEqual(result);
    expect(store.inbox.claim).toHaveBeenCalledOnce();
    expect(store.returns.create).toHaveBeenCalledOnce();
  });

  it('有效失败行计入失败金额并冻结批次', async () => {
    const store = assemble([{
      instructionId: 'instruction-001', outcome: 'failed' as const,
      amountMinor: 839_500, bankLineReference: 'bank-line-failed-001',
    }]);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-failed', BATCH_ID, 4)))
      .resolves.toMatchObject({
        status: 'frozen', failedCount: 1, failedMinor: 839_500,
      });
  });

  it.each([
    ['处理期间绑定变化', (store: ReturnType<typeof assemble>) => {
      store.inbox.claim.mockImplementation(() => {
        store.mutateBatch({ version: 5 });
        return Promise.resolve(store.manifest);
      });
    }, 'TREASURY_BANK_RETURN_BINDING_CHANGED'],
    ['支付指令不完整', (store: ReturnType<typeof assemble>) => {
      store.instructions.find.mockReturnValue(query(() => []));
    }, 'TREASURY_BANK_RETURN_INSTRUCTION_INCOMPLETE'],
    ['支付指令密文绑定错位', (store: ReturnType<typeof assemble>) => {
      store.setInstructionData({
        ...store.getInstructionData(), instructionId: 'instruction-other',
      });
    }, 'TREASURY_RETURN_INSTRUCTION_BINDING_MISMATCH'],
    ['批次写入冲突', (store: ReturnType<typeof assemble>) => {
      store.batches.updateOne.mockResolvedValue({ modifiedCount: 0 });
    }, 'TREASURY_BANK_RETURN_WRITE_CONFLICT'],
    ['支付行写入冲突', (store: ReturnType<typeof assemble>) => {
      store.instructions.updateOne.mockResolvedValue({ modifiedCount: 0 });
    }, 'TREASURY_RETURN_LINE_WRITE_CONFLICT'],
  ])('%s时在线回盘失败关闭', async (_label, arrange, code) => {
    const store = assemble();
    arrange(store);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest(`treasury-return-conflict-${_label}`, BATCH_ID, 4)))
      .rejects.toMatchObject({ response: { code } });
  });

  it('异常回盘未冻结全部支付指令时拒绝完成', async () => {
    const store = assemble([{
      instructionId: 'unknown-line', outcome: 'succeeded' as const,
      amountMinor: 839_500, bankLineReference: 'bank-line-001',
    }]);
    store.instructions.updateMany.mockResolvedValue({ modifiedCount: 0 });
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest('treasury-return-freeze-conflict', BATCH_ID, 4)))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_RETURN_FREEZE_INCOMPLETE' },
      });
  });

  it.each([
    ['非法密文', (store: ReturnType<typeof assemble>) => {
      store.setInstructionData({});
    }, 'TREASURY_RETURN_PROTECTED_DATA_INVALID'],
    ['重复回盘', (store: ReturnType<typeof assemble>) => {
      store.returns.create.mockRejectedValue({ code: 11_000 });
    }, 'TREASURY_BANK_RETURN_REPLAYED'],
  ])('%s转换为稳定冲突码', async (_label, arrange, code) => {
    const store = assemble();
    arrange(store);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.ingest(`treasury-return-mapped-${_label}`, BATCH_ID, 4)))
      .rejects.toMatchObject({ response: { code } });
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
