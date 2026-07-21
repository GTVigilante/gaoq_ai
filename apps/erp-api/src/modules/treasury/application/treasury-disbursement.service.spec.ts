import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { payrollDigest } from '../../payroll/domain/index.js';
import { TreasuryDisbursementService } from './treasury-disbursement.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const DEBTOR_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const CREDITOR_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const CALCULATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4L1';
const LINE_HASH = 'l'.repeat(43);
const ZERO_LINE_HASH = 'z'.repeat(43);
const RUN_HASH = payrollDigest([{ employeeId: 'employee-001', resultHash: LINE_HASH }]);
const executionDate = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
const input = {
  payrollPeriodId: PERIOD_ID, expectedPayrollVersion: 6,
  debtorBankAccountId: DEBTOR_ID, requestedExecutionDate: executionDate,
};

function actor(actorId = 'treasury-maker'): ActorContext {
  return {
    actorType: 'user', actorId, tenantId: tenant.tenantId,
    roleCodes: ['treasury'], scopes: ['erp:treasury:disbursement:prepare'],
    departmentIds: [], traceId: 'trace-001',
  };
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), sort: vi.fn(), lean: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function assemble(lockedBy = 'payroll-locker') {
  const context = new TenantContextService();
  const protectedValues = new Map<string, unknown>([
    ['debtor-cipher', {
      accountName: '高企科技', account: '6222000000000001',
      clearingCode: 'CNAPS001', currency: 'CNY',
    }],
    ['creditor-cipher', {
      accountName: '张三', account: '6222000000000002',
      clearingCode: 'CNAPS002', currency: 'CNY',
    }],
  ]);
  const crypto = {
    protect: vi.fn((cryptoContext: { resourceId: string; resourceType: string }, value: unknown) => {
      const ciphertext = `${cryptoContext.resourceType}-${cryptoContext.resourceId}`;
      protectedValues.set(ciphertext, value);
      return { keyId: 'treasury-key', iv: 'iv', ciphertext, authTag: 'tag' };
    }),
    unprotect: vi.fn((_cryptoContext: unknown, value: { ciphertext: string }) =>
      protectedValues.get(value.ciphertext)),
  };
  const payroll = { getLockedDisbursementSource: vi.fn().mockResolvedValue({
    periodId: PERIOD_ID, period: '2026-07', payrollRunId: RUN_ID,
    payrollLockedBy: lockedBy, payrollVersion: 6, resultHash: RUN_HASH,
    totalNetMinor: 839_500, lines: [{
      calculationLineId: CALCULATION_ID, employeeId: 'employee-001',
      netPayMinor: 839_500, resultHash: LINE_HASH,
    }],
  }) };
  const debtor = {
    id: DEBTOR_ID, tenantId: 'tenant-001', ownerType: 'organization', ownerId: 'tenant-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'debtor-cipher', dataAuthTag: 'tag',
  };
  const creditor = {
    id: CREDITOR_ID, tenantId: 'tenant-001', ownerType: 'employee', ownerId: 'employee-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'creditor-cipher', dataAuthTag: 'tag',
  };
  const accounts = {
    findOne: vi.fn().mockReturnValue(query(() => debtor)),
    find: vi.fn().mockReturnValue(query(() => [creditor])),
  };
  let batch: Record<string, unknown> | null = null;
  const batches = {
    create: vi.fn((documents: readonly Record<string, unknown>[]) => {
      batch = { ...documents[0] };
      return Promise.resolve([]);
    }),
    findOne: vi.fn().mockImplementation(() => query(() => batch)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  let instructionRecords: readonly Record<string, unknown>[] = [];
  const instructions = {
    create: vi.fn((documents: readonly Record<string, unknown>[]) => {
      instructionRecords = documents.map((document) => ({ ...document }));
      return Promise.resolve([]);
    }),
    find: vi.fn().mockImplementation(() => query(() => instructionRecords)),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  let archivedBody = '';
  const archive = { put: vi.fn((request: { readonly bytes: Buffer }) => {
    archivedBody = request.bytes.toString('utf8');
    return Promise.resolve({
      objectRef: 'worm/treasury/object-001', receiptId: 'receipt-001', immutable: true,
    });
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new TreasuryDisbursementService(
    idempotency as never, context, payroll as never, crypto as never,
    archive as never, outbox as never, accounts as never,
    instructions as never, batches as never,
  );
  return {
    context, crypto, payroll, accounts, batches, instructions,
    idempotency, archive, archivedBody: () => archivedBody, outbox, service,
  };
}

describe('TreasuryDisbursementService', () => {
  it('从锁定工资形成密文指令，WORM 成功后才把批次转为 prepared', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-001', input));
    expect(result).toMatchObject({
      payrollPeriodId: PERIOD_ID, payrollRunId: RUN_ID,
      status: 'prepared', version: 2, lineCount: 1, totalMinor: 839_500,
      objectEvidenceId: 'receipt-001',
    });
    expect(result.fileHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.idempotency.execute).toHaveBeenCalledTimes(2);
    expect(store.archive.put).toHaveBeenCalledOnce();
    expect(store.batches.updateOne).toHaveBeenCalledOnce();
    expect(store.instructions.updateMany).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
    const persistence = JSON.stringify([
      store.batches.create.mock.calls, store.instructions.create.mock.calls,
      store.outbox.append.mock.calls, result,
    ]);
    expect(persistence).not.toMatch(/622200000000000[12]|张三|高企科技/u);
    expect(store.archivedBody()).toContain('<Document xmlns=');
    expect(store.archivedBody()).toContain('8395.00');
  });

  it('制备人与工资锁定人相同则在创建批次前失败', async () => {
    const store = assemble('same-user');
    await expect(store.context.run({ tenant, actor: actor('same-user') }, () =>
      store.service.prepare('treasury-disbursement-001', input))).rejects.toMatchObject({
      response: { code: 'TREASURY_DUAL_CONTROL_REQUIRED' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
  });

  it('WORM 失败时保留 materializing 事务结果且不伪造 prepared 状态', async () => {
    const store = assemble();
    store.archive.put.mockRejectedValue(new Error('TREASURY_WORM_ARCHIVE_HTTP_503'));
    await expect(store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-001', input)))
      .rejects.toThrow('TREASURY_WORM_ARCHIVE_HTTP_503');
    expect(store.batches.create).toHaveBeenCalledOnce();
    expect(store.batches.updateOne).not.toHaveBeenCalled();
    expect(store.instructions.updateMany).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it('零实发行不进入银行文件且不破坏全量工资摘要绑定', async () => {
    const store = assemble();
    const resultHash = payrollDigest([
      { employeeId: 'employee-001', resultHash: LINE_HASH },
      { employeeId: 'employee-002', resultHash: ZERO_LINE_HASH },
    ]);
    store.payroll.getLockedDisbursementSource.mockResolvedValue({
      periodId: PERIOD_ID, period: '2026-07', payrollRunId: RUN_ID,
      payrollLockedBy: 'payroll-locker', payrollVersion: 6, resultHash,
      totalNetMinor: 839_500, lines: [
        {
          calculationLineId: CALCULATION_ID, employeeId: 'employee-001',
          netPayMinor: 839_500, resultHash: LINE_HASH,
        },
        {
          calculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4L2', employeeId: 'employee-002',
          netPayMinor: 0, resultHash: ZERO_LINE_HASH,
        },
      ],
    });
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-zero-line', input));
    expect(result).toMatchObject({ status: 'prepared', lineCount: 1, totalMinor: 839_500 });
    expect(store.accounts.find).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: { $in: ['employee-001'] },
    }));
    expect(store.instructions.create.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
