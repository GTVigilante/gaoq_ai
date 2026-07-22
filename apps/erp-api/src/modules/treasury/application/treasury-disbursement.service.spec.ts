import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { ConfigService } from '@nestjs/config';
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
const EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const LINE_HASH = 'l'.repeat(43);
const ZERO_LINE_HASH = 'z'.repeat(43);
const RUN_HASH = payrollDigest([{ employeeId: 'employee-001', resultHash: LINE_HASH }]);
const MIGRATION_RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const MIGRATION_APPROVAL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4H1';
const PREPARER_EMPLOYEE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4M1';
const APPROVER_EMPLOYEE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4M2';
const MIGRATION_EVIDENCE_REF =
  `erp://data-migrations/runs/${MIGRATION_RUN_ID}/attachments/batch-001`;
const executionDate = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
const input = {
  payrollPeriodId: PERIOD_ID, expectedPayrollVersion: 6,
  debtorBankAccountId: DEBTOR_ID, requestedExecutionDate: executionDate,
};

function actor(actorId = 'treasury-maker'): ActorContext {
  return {
    actorType: 'user', actorId, tenantId: tenant.tenantId,
    roleCodes: ['treasury'], scopes: [
      'erp:treasury:disbursement:prepare', 'erp:treasury:disbursement:approve',
    ],
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

function assemble(
  lockedBy = 'payroll-locker',
  submissionMode: 'sandbox' | 'production' = 'sandbox',
) {
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
  const lockedSource = {
    periodId: PERIOD_ID, period: '2026-07', payrollRunId: RUN_ID,
    payrollLockedBy: lockedBy, lockedAt: '2026-07-22T08:00:00.000Z',
    payrollVersion: 6, resultHash: RUN_HASH,
    totalNetMinor: 839_500, lines: [{
      calculationLineId: CALCULATION_ID, employeeId: 'employee-001',
      netPayMinor: 839_500, resultHash: LINE_HASH,
    }],
  };
  const payroll = {
    getLockedDisbursementSource: vi.fn().mockResolvedValue(lockedSource),
    getLockedDisbursementSourceForMigration: vi.fn().mockResolvedValue(lockedSource),
  };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: EVIDENCE_ID, credentialId: 'credential-001', tenantId: tenant.tenantId,
    actorId: 'treasury-checker', sessionId: 'session-001', operationId: '',
    method: 'webauthn_uv', verifiedAt: new Date().toISOString(),
  }) };
  const debtor = {
    id: DEBTOR_ID, tenantId: 'tenant-001', ownerType: 'organization', ownerId: 'tenant-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'debtor-cipher', dataAuthTag: 'tag',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), revokedAt: null,
  };
  const creditor = {
    id: CREDITOR_ID, tenantId: 'tenant-001', ownerType: 'employee', ownerId: 'employee-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'creditor-cipher', dataAuthTag: 'tag',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), revokedAt: null,
  };
  const accounts = {
    findOne: vi.fn().mockReturnValue(query(() => debtor)),
    find: vi.fn().mockReturnValue(query(() => [creditor])),
  };
  let batch: Record<string, unknown> | null = null;
  const batches = {
    create: vi.fn((documents: readonly Record<string, unknown>[]) => {
      const document = documents[0] ?? {};
      batch = {
        ...document,
        createdAt: document.createdAt ?? new Date(),
        updatedAt: document.updatedAt ?? new Date(),
      };
      return Promise.resolve([]);
    }),
    findOne: vi.fn().mockImplementation(() => query(() => batch)),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      batch = { ...batch, ...update.$set, updatedAt: new Date() };
      return Promise.resolve({ modifiedCount: 1 });
    }),
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
  const idempotencyResults = new Map<string, Record<string, unknown>>();
  const idempotency = { execute: vi.fn(async (
    operation: string,
    key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => {
    const cacheKey = `${operation}:${key}`;
    const existing = idempotencyResults.get(cacheKey);
    if (existing !== undefined) return existing;
    const result = await handler(session);
    idempotencyResults.set(cacheKey, result);
    return result;
  }) };
  let archivedBody = '';
  const archive = { put: vi.fn((request: { readonly bytes: Buffer }) => {
    archivedBody = request.bytes.toString('utf8');
    return Promise.resolve({
      objectRef: 'worm/treasury/object-001', receiptId: 'receipt-001', immutable: true as const,
    });
  }) };
  const bankGateway = { submit: vi.fn().mockResolvedValue({
    submissionId: 'bank-submission-001', evidenceId: 'bank-evidence-001', accepted: true,
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const profiles = { findActorIdByEmployee: vi.fn().mockImplementation(
    (_tenantId: string, employeeId: string) => Promise.resolve(
      employeeId === PREPARER_EMPLOYEE_ID ? 'treasury-migration-maker' :
        employeeId === APPROVER_EMPLOYEE_ID ? 'treasury-migration-checker' : null,
    ),
  ) };
  const approvals = { verifyTreasuryMigrationReference: vi.fn().mockResolvedValue({
    id: MIGRATION_APPROVAL_ID,
    templateCode: 'treasury_disbursement_export_approval',
    completedAt: '2026-07-22T10:00:00.000Z', evidenceChecksum: 'a'.repeat(43),
  }) };
  const service = new TreasuryDisbursementService(
    idempotency as never, context, payroll as never, strongAuth as never, crypto as never,
    archive, bankGateway,
    new ConfigService({ TREASURY_BANK_SUBMISSION_MODE: submissionMode }) as never,
    outbox as never, accounts as never,
    instructions as never, batches as never,
    profiles as never, approvals as never,
  );
  return {
    context, crypto, payroll, strongAuth, accounts, batches, instructions,
    idempotency, archive, bankGateway, archivedBody: () => archivedBody, outbox,
    profiles, approvals, service,
  };
}

function migrationActor(actorType: 'service' | 'user' = 'service'): ActorContext {
  return {
    actorType, actorId: 'migration-worker', tenantId: tenant.tenantId,
    roleCodes: [], scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
    departmentIds: [], traceId: 'trace-migration-001',
  };
}

function migrationInput(targetId: string | null = null) {
  return {
    targetId, payrollPeriodId: PERIOD_ID, payrollRunId: RUN_ID,
    expectedPayrollVersion: 6, debtorBankAccountId: DEBTOR_ID,
    preparedByEmployeeId: PREPARER_EMPLOYEE_ID,
    exportApprovedByEmployeeId: APPROVER_EMPLOYEE_ID,
    approvalHistoryId: MIGRATION_APPROVAL_ID,
    approvalEvidenceChecksum: 'a'.repeat(43), requestedExecutionDate: '2026-07-23',
    lines: [{
      employeeId: 'employee-001', bankAccountId: CREDITOR_ID,
      expectedNetPayMinor: 839_500,
    }],
    expectedLineCount: 1, expectedTotalMinor: 839_500,
    bankSubmissionId: 'legacy-bank-submission-001',
    bankSubmissionEvidenceId: 'legacy-bank-evidence-001',
    preparedAt: '2026-07-22T09:00:00.000Z',
    submittedAt: '2026-07-22T11:00:00.000Z',
    migrationEvidenceRef: MIGRATION_EVIDENCE_REF, evidenceChecksum: 'e'.repeat(43),
  };
}

describe('TreasuryDisbursementService', () => {
  it('以确定性密文快照恢复已提交常规批次且不调用 WORM 或银行网关', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importSubmittedFromMigration('treasury-batch-migration', migrationInput()));
    expect(result).toMatchObject({
      status: 'submitted', version: 4, lineCount: 1, totalMinor: 839_500,
      bankSubmissionId: 'legacy-bank-submission-001',
      bankSubmissionEvidenceId: 'legacy-bank-evidence-001',
    });
    expect(store.archive.put).not.toHaveBeenCalled();
    expect(store.bankGateway.submit).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'treasury.disbursement.migrated', version: 4,
    }), session);
    const persistence = JSON.stringify([
      store.batches.create.mock.calls, store.instructions.create.mock.calls,
      store.outbox.append.mock.calls,
    ]);
    expect(persistence).not.toMatch(/622200000000000[12]|张三|高企科技/u);

    await expect(store.context.run({ tenant, actor: migrationActor() }, () =>
      store.service.importSubmittedFromMigration(
        'treasury-batch-migration-replay', migrationInput(result.id),
      ))).resolves.toEqual(result);
    expect(store.batches.create).toHaveBeenCalledOnce();
    expect(store.instructions.create).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it('拒绝用户身份执行批次迁移，并在三岗角色冲突时拒绝落库', async () => {
    const denied = assemble();
    await expect(denied.context.run({ tenant, actor: migrationActor('user') }, () =>
      denied.service.importSubmittedFromMigration('denied', migrationInput())))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_DISBURSEMENT_MIGRATION_WRITER_DENIED' },
      });
    expect(denied.batches.create).not.toHaveBeenCalled();

    const conflicted = assemble('treasury-migration-maker');
    await expect(conflicted.context.run({ tenant, actor: migrationActor() }, () =>
      conflicted.service.importSubmittedFromMigration('role-conflict', migrationInput())))
      .rejects.toMatchObject({
        response: { code: 'TREASURY_DISBURSEMENT_MIGRATION_CONTROL_INVALID' },
      });
    expect(conflicted.batches.create).not.toHaveBeenCalled();
  });

  it('Phase 6 总体切换授权未实现前真实银行模式始终失败关闭', async () => {
    const store = assemble('payroll-locker', 'production');
    const connector: ActorContext = {
      actorType: 'service', actorId: 'bank-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:treasury:disbursement:submit'],
      departmentIds: [], traceId: 'trace-bank-production-gate',
    };
    await expect(store.context.run({ tenant, actor: connector }, () => store.service.submit(
      'treasury-production-submit', '01J8ZQK7V0A2M4N6P8R0T2W4B1', { expectedVersion: 3 },
    ))).rejects.toThrow('真实银行提交失败关闭');
    expect(store.bankGateway.submit).not.toHaveBeenCalled();
  });

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

  it('只有独立批准人凭批次绑定的 WebAuthn 证据才能批准导出', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-approval', input));
    const checker = actor('treasury-checker');
    const token = {
      issuer: 'https://erp.example.test', subject: checker.actorId,
      audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
      actorId: checker.actorId, actorType: 'user' as const, clientId: 'erp-web',
      roleCodes: checker.roleCodes, scopes: checker.scopes,
      departmentIds: [], sessionId: 'session-001', expiresAt: Date.now() + 60_000,
    };
    const result = await store.context.run({ tenant, actor: checker }, () =>
      store.service.approveExport('treasury-export-approval', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, token));
    expect(result).toMatchObject({ status: 'exported', version: 3 });
    expect(store.strongAuth.requireVerifiedEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: EVIDENCE_ID, actorId: 'treasury-checker', sessionId: 'session-001',
    }));
  });

  it('只有可信服务取得绑定回执后才把批次与全部指令转为 submitted', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-submission', input));
    const checker = actor('treasury-checker');
    const token = {
      issuer: 'https://erp.example.test', subject: checker.actorId,
      audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
      actorId: checker.actorId, actorType: 'user' as const, clientId: 'erp-web',
      roleCodes: checker.roleCodes, scopes: checker.scopes,
      departmentIds: [], sessionId: 'session-001', expiresAt: Date.now() + 60_000,
    };
    const exported = await store.context.run({ tenant, actor: checker }, () =>
      store.service.approveExport('treasury-export-for-submit', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, token));
    const connector: ActorContext = {
      actorType: 'service', actorId: 'bank-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:treasury:disbursement:submit'],
      departmentIds: [], traceId: 'trace-bank-001',
    };
    const result = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('treasury-bank-submit', exported.id, { expectedVersion: 3 }));
    expect(result).toMatchObject({
      status: 'submitted', version: 4, bankSubmissionId: 'bank-submission-001',
      bankSubmissionEvidenceId: 'bank-evidence-001',
    });
    expect(store.bankGateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      batchId: exported.id, fileHash: exported.fileHash, lineCount: 1, totalMinor: 839_500,
    }));
    expect(store.instructions.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'prepared' }),
      { $set: { status: 'submitted' } }, expect.any(Object),
    );
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('treasury-bank-submit', exported.id, { expectedVersion: 3 })))
      .resolves.toEqual(result);
    expect(store.bankGateway.submit).toHaveBeenCalledOnce();
  });

  it('银行网关首次失败后保留 submitting，幂等记录过期后仍可恢复且不另建批次', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-disbursement-retry', input));
    const checker = actor('treasury-checker');
    const token = {
      issuer: 'https://erp.example.test', subject: checker.actorId,
      audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
      actorId: checker.actorId, actorType: 'user' as const, clientId: 'erp-web',
      roleCodes: checker.roleCodes, scopes: checker.scopes,
      departmentIds: [], sessionId: 'session-001', expiresAt: Date.now() + 60_000,
    };
    const exported = await store.context.run({ tenant, actor: checker }, () =>
      store.service.approveExport('treasury-export-retry', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, token));
    const connector: ActorContext = {
      actorType: 'service', actorId: 'bank-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:treasury:disbursement:submit'],
      departmentIds: [], traceId: 'trace-bank-001',
    };
    store.bankGateway.submit.mockRejectedValueOnce(new Error('TREASURY_BANK_SUBMISSION_HTTP_503'));
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('treasury-bank-retry-after-ttl', exported.id, { expectedVersion: 3 })))
      .rejects.toThrow('TREASURY_BANK_SUBMISSION_HTTP_503');
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('treasury-bank-retry', exported.id, { expectedVersion: 3 })))
      .resolves.toMatchObject({ status: 'submitted', version: 4 });
    expect(store.bankGateway.submit).toHaveBeenCalledTimes(2);
    expect(store.batches.create).toHaveBeenCalledOnce();
  });
});
