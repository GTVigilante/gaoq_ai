import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { productionExecutionSubjectHash } from '../../../core/production-execution/production-execution-authorization.service.js';
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
  omitMigrationDependencies = false,
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
  let debtor: Record<string, unknown> | null = {
    id: DEBTOR_ID, tenantId: 'tenant-001', ownerType: 'organization', ownerId: 'tenant-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'debtor-cipher', dataAuthTag: 'tag',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), revokedAt: null,
  };
  let creditorRecords: readonly Record<string, unknown>[] = [{
    id: CREDITOR_ID, tenantId: 'tenant-001', ownerType: 'employee', ownerId: 'employee-001',
    version: 1, dataKeyId: 'key', dataIv: 'iv',
    dataCiphertext: 'creditor-cipher', dataAuthTag: 'tag',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), revokedAt: null,
  }];
  const accounts = {
    findOne: vi.fn().mockReturnValue(query(() => debtor)),
    find: vi.fn().mockImplementation(() => query(() => creditorRecords)),
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
  const bankGateway = { submit: vi.fn().mockImplementation((request: {
    productionAuthorization: { evidenceId: string } | null;
  }) => Promise.resolve({
    submissionId: 'bank-submission-001', evidenceId: 'bank-evidence-001', accepted: true,
    productionAuthorizationEvidenceId: request.productionAuthorization?.evidenceId ?? null,
  })) };
  const productionAuthorization = { authorize: vi.fn().mockResolvedValue({
    authorizationId: 'authorization-001', evidenceId: 'authorization-evidence-001',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    releaseCommitSha: 'c'.repeat(40), deploymentManifestHash: `sha256:${'d'.repeat(64)}`,
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
    productionAuthorization as never,
    outbox as never, accounts as never,
    instructions as never, batches as never,
    omitMigrationDependencies ? undefined : profiles as never,
    omitMigrationDependencies ? undefined : approvals as never,
  );
  return {
    context, crypto, payroll, strongAuth, accounts, batches, instructions,
    idempotency, archive, bankGateway, archivedBody: () => archivedBody, outbox,
    profiles, approvals, productionAuthorization, service,
    lockedSource,
    getBatch: () => batch,
    setBatch: (value: Record<string, unknown> | null) => { batch = value; },
    mutateBatch: (changes: Readonly<Record<string, unknown>>) => {
      batch = { ...batch, ...changes };
    },
    getInstructions: () => instructionRecords,
    setInstructions: (value: readonly Record<string, unknown>[]) => {
      instructionRecords = value;
    },
    setDebtor: (value: Record<string, unknown> | null) => { debtor = value; },
    setCreditors: (value: readonly Record<string, unknown>[]) => {
      creditorRecords = value;
    },
    getCreditors: () => creditorRecords,
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

function checkerToken(checker = actor('treasury-checker')) {
  return {
    issuer: 'https://erp.example.test', subject: checker.actorId,
    audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
    actorId: checker.actorId, actorType: 'user' as const, clientId: 'erp-web',
    roleCodes: checker.roleCodes, scopes: checker.scopes,
    departmentIds: [], sessionId: 'session-001', expiresAt: Date.now() + 60_000,
  };
}

const connector: ActorContext = {
  actorType: 'service', actorId: 'bank-connector', tenantId: tenant.tenantId,
  roleCodes: [], scopes: ['erp:treasury:disbursement:submit'],
  departmentIds: [], traceId: 'trace-bank-guard',
};

async function prepareAndApprove(store: ReturnType<typeof assemble>, key: string) {
  const prepared = await store.context.run({ tenant, actor: actor() }, () =>
    store.service.prepare(`${key}-prepare`, input));
  const checker = actor('treasury-checker');
  return store.context.run({ tenant, actor: checker }, () =>
    store.service.approveExport(`${key}-approve`, prepared.id, {
      expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
    }, checkerToken(checker)));
}

async function leaveMaterializing(store: ReturnType<typeof assemble>, key: string) {
  store.archive.put.mockRejectedValueOnce(new Error('EXPECTED_ARCHIVE_FAILURE'));
  await expect(store.context.run({ tenant, actor: actor() }, () =>
    store.service.prepare(key, input))).rejects.toThrow('EXPECTED_ARCHIVE_FAILURE');
  const batch = store.getBatch();
  if (batch === null || typeof batch.id !== 'string') {
    throw new Error('测试未建立物化批次');
  }
  return batch.id;
}

function runMigration(
  store: ReturnType<typeof assemble>,
  key: string,
  value = migrationInput(),
) {
  return store.context.run({ tenant, actor: migrationActor() }, () =>
    store.service.importSubmittedFromMigration(key, value));
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

  it('真实银行模式缺少短时授权时失败关闭，有效授权才允许提交', async () => {
    const store = assemble('payroll-locker', 'production');
    const prepared = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.prepare('treasury-production-prepare', input));
    const checker = actor('treasury-checker');
    const token = {
      issuer: 'https://erp.example.test', subject: checker.actorId,
      audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
      actorId: checker.actorId, actorType: 'user' as const, clientId: 'erp-web',
      roleCodes: checker.roleCodes, scopes: checker.scopes,
      departmentIds: [], sessionId: 'session-001', expiresAt: Date.now() + 60_000,
    };
    const exported = await store.context.run({ tenant, actor: checker }, () =>
      store.service.approveExport('treasury-production-approval', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, token));
    const connector: ActorContext = {
      actorType: 'service', actorId: 'bank-connector', tenantId: tenant.tenantId,
      roleCodes: [], scopes: ['erp:treasury:disbursement:submit'],
      departmentIds: [], traceId: 'trace-bank-production-gate',
    };
    store.productionAuthorization.authorize.mockRejectedValueOnce(
      new Error('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE'),
    );
    await expect(store.context.run({ tenant, actor: connector }, () => store.service.submit(
      'treasury-production-submit-denied', exported.id, { expectedVersion: 3 },
    ))).rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE');
    expect(store.bankGateway.submit).not.toHaveBeenCalled();
    await expect(store.context.run({ tenant, actor: connector }, () => store.service.submit(
      'treasury-production-submit-approved', exported.id, { expectedVersion: 3 },
    ))).resolves.toMatchObject({ status: 'submitted', bankSubmissionId: 'bank-submission-001' });
    const authorizationCall = store.productionAuthorization.authorize.mock.lastCall as
      | [{ action: string; tenantId: string; resourceId: string; subjectHash: string;
        expectedVersion: number }]
      | undefined;
    if (authorizationCall === undefined) throw new Error('测试缺少生产授权调用');
    expect(authorizationCall[0]).toMatchObject({
      action: 'treasury-bank-submission', tenantId: tenant.tenantId,
      resourceId: exported.id, expectedVersion: 3,
    });
    expect(authorizationCall[0].subjectHash).toBe(productionExecutionSubjectHash([
      PERIOD_ID, RUN_ID, 'worm/treasury/object-001', exported.fileHash as string,
      1, 839_500, 'receipt-001', 'treasury-checker',
      EVIDENCE_ID, 'webauthn_evidence',
    ]));
    const gatewayCall = store.bankGateway.submit.mock.lastCall as
      | [{ productionAuthorization: { authorizationId: string } | null }]
      | undefined;
    if (gatewayCall === undefined) throw new Error('测试缺少银行网关调用');
    expect(gatewayCall[0].productionAuthorization?.authorizationId).toBe('authorization-001');
  });

  it('生产授权缺少 WORM、批准人或强认证证据时在签发前失败关闭', async () => {
    for (const [field, value] of [
      ['objectEvidenceId', null],
      ['exportApprovedBy', null],
      ['strongAuthEvidenceId', null],
      ['strongAuthReferenceType', null],
    ] as const) {
      const store = assemble('payroll-locker', 'production');
      const exported = await prepareAndApprove(store, `production-evidence-${field}`);
      store.mutateBatch({ [field]: value });
      await expect(store.context.run({ tenant, actor: connector }, () =>
        store.service.submit(`production-evidence-submit-${field}`, exported.id, {
          expectedVersion: 3,
        }))).rejects.toThrow('审批证据不足以申请生产执行授权');
      expect(store.productionAuthorization.authorize).not.toHaveBeenCalled();
      expect(store.bankGateway.submit).not.toHaveBeenCalled();
    }
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

  it('制备、审批和提交入口分别强制权限、可信身份与引用格式', async () => {
    const noScopes: ActorContext = { ...actor(), scopes: [] };
    const serviceMaker: ActorContext = {
      ...connector, scopes: ['erp:treasury:disbursement:prepare'],
    };
    for (const [store, operation] of [
      [assemble(), (candidate: ReturnType<typeof assemble>) =>
        candidate.context.run({ tenant, actor: noScopes }, () =>
          candidate.service.prepare('guard-prepare-scope', input))],
      [assemble(), (candidate: ReturnType<typeof assemble>) =>
        candidate.context.run({ tenant, actor: serviceMaker }, () =>
          candidate.service.prepare('guard-prepare-human', input))],
      [assemble(), (candidate: ReturnType<typeof assemble>) =>
        candidate.context.run({ tenant, actor: actor() }, () =>
          candidate.service.prepare('guard-prepare-date', {
            ...input, requestedExecutionDate: '2026-13-01',
          }))],
    ] as const) {
      await expect(operation(store)).rejects.toThrow();
      expect(store.batches.create).not.toHaveBeenCalled();
    }

    const approval = assemble();
    const prepared = await approval.context.run({ tenant, actor: actor() }, () =>
      approval.service.prepare('guard-approve-prepare', input));
    await expect(approval.context.run({ tenant, actor: noScopes }, () =>
      approval.service.approveExport('guard-approve-scope', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, checkerToken(noScopes)))).rejects.toThrow('缺少代发导出批准权限');
    const serviceApprover: ActorContext = {
      ...connector, scopes: ['erp:treasury:disbursement:approve'],
    };
    await expect(approval.context.run({ tenant, actor: serviceApprover }, () =>
      approval.service.approveExport('guard-approve-identity', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, checkerToken()))).rejects.toThrow('批准身份上下文非法');
    await expect(approval.context.run({ tenant, actor: actor('treasury-checker') }, () =>
      approval.service.approveExport('guard-approve-id', 'bad/id', {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, checkerToken()))).rejects.toThrow('代发批次标识非法');

    const submission = assemble();
    await expect(submission.context.run({ tenant, actor: noScopes }, () =>
      submission.service.submit('guard-submit-scope', PERIOD_ID, { expectedVersion: 3 })))
      .rejects.toThrow('缺少代发银行提交权限');
    const humanSubmitter: ActorContext = {
      ...actor(), scopes: ['erp:treasury:disbursement:submit'],
    };
    await expect(submission.context.run({ tenant, actor: humanSubmitter }, () =>
      submission.service.submit('guard-submit-service', PERIOD_ID, { expectedVersion: 3 })))
      .rejects.toThrow('受信任银行提交服务');
    await expect(submission.context.run({ tenant, actor: connector }, () =>
      submission.service.submit('guard-submit-id', 'bad/id', { expectedVersion: 3 })))
      .rejects.toThrow('代发批次标识非法');
  });

  it('制备阶段拒绝空工资、缺失账户、重复账户、总额漂移和执行窗口越界', async () => {
    const empty = assemble();
    empty.payroll.getLockedDisbursementSource.mockResolvedValue({
      ...empty.lockedSource, totalNetMinor: 0, lines: [],
    });
    await expect(empty.context.run({ tenant, actor: actor() }, () =>
      empty.service.prepare('prepare-empty', input))).rejects.toThrow('没有可代发员工');

    const debtorMissing = assemble();
    debtorMissing.setDebtor(null);
    await expect(debtorMissing.context.run({ tenant, actor: actor() }, () =>
      debtorMissing.service.prepare('prepare-debtor-missing', input)))
      .rejects.toThrow('组织付款账户不存在');

    const creditorMissing = assemble();
    creditorMissing.setCreditors([]);
    await expect(creditorMissing.context.run({ tenant, actor: actor() }, () =>
      creditorMissing.service.prepare('prepare-creditor-missing', input)))
      .rejects.toThrow('员工的活动银行账户不完整');

    const creditorDuplicate = assemble();
    const [creditor] = creditorDuplicate.getCreditors();
    if (creditor === undefined) throw new Error('测试缺少员工银行账户夹具');
    creditorDuplicate.setCreditors([creditor, { ...creditor, id: `${CREDITOR_ID}-duplicate` }]);
    await expect(creditorDuplicate.context.run({ tenant, actor: actor() }, () =>
      creditorDuplicate.service.prepare('prepare-creditor-duplicate', input)))
      .rejects.toThrow('员工的活动银行账户不完整');

    const totalMismatch = assemble();
    totalMismatch.payroll.getLockedDisbursementSource.mockResolvedValue({
      ...totalMismatch.lockedSource, totalNetMinor: 839_501,
    });
    await expect(totalMismatch.context.run({ tenant, actor: actor() }, () =>
      totalMismatch.service.prepare('prepare-total-mismatch', input)))
      .rejects.toThrow('实发总额与代发行不一致');

    const outOfRange = assemble();
    await expect(outOfRange.context.run({ tenant, actor: actor() }, () =>
      outOfRange.service.prepare('prepare-date-range', {
        ...input, requestedExecutionDate: '2000-01-01',
      }))).rejects.toThrow('未来九十天内');
  });

  it('物化入口对缺失、已完成和非法状态提供稳定幂等语义', async () => {
    const missing = assemble();
    await expect(missing.context.run({ tenant, actor: actor() }, () =>
      missing.service.materializeStaged('materialize-missing', PERIOD_ID)))
      .rejects.toThrow('代发批次不存在');

    const prepared = assemble();
    const result = await prepared.context.run({ tenant, actor: actor() }, () =>
      prepared.service.prepare('materialize-prepared', input));
    await expect(prepared.context.run({ tenant, actor: actor() }, () =>
      prepared.service.materializeStaged('materialize-prepared-replay', result.id)))
      .resolves.toEqual(result);
    expect(prepared.archive.put).toHaveBeenCalledOnce();

    prepared.mutateBatch({ status: 'exported' });
    await expect(prepared.context.run({ tenant, actor: actor() }, () =>
      prepared.service.materializeStaged('materialize-invalid-state', result.id)))
      .rejects.toThrow('不处于可物化状态');
  });

  it('物化时拒绝指令缺失、密文绑定漂移、工资摘要漂移和总额漂移', async () => {
    const incomplete = assemble();
    const incompleteId = await leaveMaterializing(incomplete, 'materialize-incomplete');
    incomplete.setInstructions([]);
    await expect(incomplete.context.run({ tenant, actor: actor() }, () =>
      incomplete.service.materializeStaged('materialize-incomplete-retry', incompleteId)))
      .rejects.toThrow('支付指令快照不完整');

    const binding = assemble();
    const bindingId = await leaveMaterializing(binding, 'materialize-binding');
    binding.setInstructions(binding.getInstructions().map((record) => ({
      ...record, employeeId: 'employee-other',
    })));
    await expect(binding.context.run({ tenant, actor: actor() }, () =>
      binding.service.materializeStaged('materialize-binding-retry', bindingId)))
      .rejects.toThrow('支付指令密文绑定不一致');

    const digest = assemble();
    const digestId = await leaveMaterializing(digest, 'materialize-digest');
    digest.mutateBatch({ payableResultHash: 'x'.repeat(43) });
    await expect(digest.context.run({ tenant, actor: actor() }, () =>
      digest.service.materializeStaged('materialize-digest-retry', digestId)))
      .rejects.toThrow('支付指令与锁定工资摘要不一致');

    const total = assemble();
    const totalId = await leaveMaterializing(total, 'materialize-total');
    total.mutateBatch({ totalMinor: 839_501 });
    await expect(total.context.run({ tenant, actor: actor() }, () =>
      total.service.materializeStaged('materialize-total-retry', totalId)))
      .rejects.toThrow('支付指令总额与批次不一致');
  });

  it('物化批次与支付指令的写竞争均失败关闭', async () => {
    const batchConflict = assemble();
    const batchId = await leaveMaterializing(batchConflict, 'materialize-batch-conflict');
    batchConflict.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(batchConflict.context.run({ tenant, actor: actor() }, () =>
      batchConflict.service.materializeStaged('materialize-batch-write', batchId)))
      .rejects.toThrow('代发批次物化并发冲突');

    const instructionConflict = assemble();
    const instructionId = await leaveMaterializing(
      instructionConflict, 'materialize-instruction-conflict',
    );
    instructionConflict.instructions.updateMany.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(instructionConflict.context.run({ tenant, actor: actor() }, () =>
      instructionConflict.service.materializeStaged(
        'materialize-instruction-write', instructionId,
      ))).rejects.toThrow('支付指令状态更新不完整');
  });

  it('审批要求完整 WORM 证据并对乐观锁冲突失败关闭', async () => {
    const incomplete = assemble();
    const prepared = await incomplete.context.run({ tenant, actor: actor() }, () =>
      incomplete.service.prepare('approve-incomplete-prepare', input));
    incomplete.mutateBatch({ objectEvidenceId: null });
    const checker = actor('treasury-checker');
    await expect(incomplete.context.run({ tenant, actor: checker }, () =>
      incomplete.service.approveExport('approve-incomplete', prepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, checkerToken(checker)))).rejects.toThrow('不可变证据不完整');

    const conflict = assemble();
    const conflictPrepared = await conflict.context.run({ tenant, actor: actor() }, () =>
      conflict.service.prepare('approve-conflict-prepare', input));
    conflict.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({ tenant, actor: checker }, () =>
      conflict.service.approveExport('approve-conflict', conflictPrepared.id, {
        expectedVersion: 2, strongAuthEvidenceId: EVIDENCE_ID,
      }, checkerToken(checker)))).rejects.toThrow('导出批准发生并发冲突');
  });

  it('提交暂存、暂存回读、终态写入和指令更新竞争均失败关闭', async () => {
    const stageConflict = assemble();
    const exported = await prepareAndApprove(stageConflict, 'submit-stage-conflict');
    stageConflict.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(stageConflict.context.run({ tenant, actor: connector }, () =>
      stageConflict.service.submit('submit-stage-conflict', exported.id, {
        expectedVersion: 3,
      }))).rejects.toThrow('提交暂存发生并发冲突');
    expect(stageConflict.bankGateway.submit).not.toHaveBeenCalled();

    const stale = assemble();
    const staleExported = await prepareAndApprove(stale, 'submit-stale');
    stale.batches.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(stale.context.run({ tenant, actor: connector }, () =>
      stale.service.submit('submit-stale', staleExported.id, { expectedVersion: 3 })))
      .rejects.toThrow('提交暂存状态非法');
    expect(stale.bankGateway.submit).not.toHaveBeenCalled();

    const batchConflict = assemble();
    const batchExported = await prepareAndApprove(batchConflict, 'submit-batch-conflict');
    let batchWrites = 0;
    batchConflict.batches.updateOne.mockImplementation((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      batchWrites += 1;
      if (batchWrites === 1) {
        batchConflict.mutateBatch(update.$set);
        return Promise.resolve({ modifiedCount: 1 });
      }
      return Promise.resolve({ modifiedCount: 0 });
    });
    await expect(batchConflict.context.run({ tenant, actor: connector }, () =>
      batchConflict.service.submit('submit-final-conflict', batchExported.id, {
        expectedVersion: 3,
      }))).rejects.toThrow('代发提交发生并发冲突');

    const instructionConflict = assemble();
    const instructionExported = await prepareAndApprove(
      instructionConflict, 'submit-instruction-conflict',
    );
    instructionConflict.instructions.updateMany.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(instructionConflict.context.run({ tenant, actor: connector }, () =>
      instructionConflict.service.submit('submit-instruction-conflict', instructionExported.id, {
        expectedVersion: 3,
      }))).rejects.toThrow('支付指令提交状态更新不完整');
  });

  it('迁移依赖、严格输入模式和历史时间不可信时在查询前拒绝', async () => {
    const missingDependencies = assemble('payroll-locker', 'sandbox', true);
    await expect(runMigration(
      missingDependencies, 'migration-dependencies',
    )).rejects.toThrow('代发迁移身份或审批依赖未装配');

    const invalid = assemble();
    const invalidInputs = [
      { ...migrationInput(), unexpected: true },
      { ...migrationInput(), targetId: 'bad/id' },
      { ...migrationInput(), requestedExecutionDate: '2026-13-01' },
      {
        ...migrationInput(),
        preparedAt: '2026-07-22T12:00:00.000Z',
        submittedAt: '2026-07-22T11:00:00.000Z',
      },
      { ...migrationInput(), preparedAt: 'not-an-instant' },
      {
        ...migrationInput(),
        lines: [{ ...migrationInput().lines[0], expectedNetPayMinor: 0 }],
      },
    ];
    for (const [index, candidate] of invalidInputs.entries()) {
      await expect(runMigration(
        invalid, `migration-input-${index}`, candidate as ReturnType<typeof migrationInput>,
      )).rejects.toMatchObject({
        response: { code: 'TREASURY_DISBURSEMENT_MIGRATION_INPUT_INVALID' },
      });
    }
  });

  it('迁移引用、账户映射、账户生效时间和锁定工资控制量必须一致', async () => {
    const identity = assemble();
    identity.profiles.findActorIdByEmployee.mockResolvedValue(null);
    await expect(runMigration(identity, 'migration-identity'))
      .rejects.toThrow('制备人、批准人或付款账户不存在');

    const debtor = assemble();
    debtor.setDebtor(null);
    await expect(runMigration(debtor, 'migration-debtor'))
      .rejects.toThrow('制备人、批准人或付款账户不存在');

    const incomplete = assemble();
    incomplete.setCreditors([]);
    await expect(runMigration(incomplete, 'migration-account-incomplete'))
      .rejects.toThrow('员工账户映射不完整');

    const binding = assemble();
    binding.setCreditors(binding.getCreditors().map((record) => ({
      ...record, ownerId: 'employee-other',
    })));
    await expect(runMigration(binding, 'migration-account-binding'))
      .rejects.toThrow('员工与银行账户绑定不一致');

    const time = assemble();
    time.setCreditors(time.getCreditors().map((record) => ({
      ...record, createdAt: new Date('2026-07-22T09:30:00.000Z'),
    })));
    await expect(runMigration(time, 'migration-account-time'))
      .rejects.toThrow('银行账户尚未生效');

    const line = assemble();
    await expect(runMigration(line, 'migration-line', {
      ...migrationInput(),
      lines: [{
        employeeId: 'employee-001', bankAccountId: CREDITOR_ID,
        expectedNetPayMinor: 839_499,
      }],
    })).rejects.toThrow('实发金额与锁定工资不一致');

    const total = assemble();
    await expect(runMigration(total, 'migration-total', {
      ...migrationInput(), expectedTotalMinor: 839_501,
    })).rejects.toThrow('行数或总额与锁定工资不一致');
  });

  it('迁移目标不存在或持久事实漂移时禁止覆盖', async () => {
    const missing = assemble();
    await expect(runMigration(
      missing, 'migration-replay-missing', migrationInput(PERIOD_ID),
    )).rejects.toMatchObject({
      response: { code: 'TREASURY_DISBURSEMENT_MIGRATION_IMMUTABLE' },
    });

    const drift = assemble();
    const imported = await runMigration(drift, 'migration-replay-create');
    drift.mutateBatch({ bankSubmissionId: 'changed-submission' });
    await expect(runMigration(
      drift, 'migration-replay-drift', migrationInput(imported.id),
    )).rejects.toMatchObject({
      response: { code: 'TREASURY_DISBURSEMENT_MIGRATION_IMMUTABLE' },
    });
  });

  it('生产模式下已提交批次重放不申请新授权也不重复调用银行', async () => {
    const replay = assemble('payroll-locker', 'production');
    const replayExported = await prepareAndApprove(replay, 'production-replay');
    await replay.context.run({ tenant, actor: connector }, () =>
      replay.service.submit('production-replay-first', replayExported.id, {
        expectedVersion: 3,
      }));
    replay.productionAuthorization.authorize.mockClear();
    await expect(replay.context.run({ tenant, actor: connector }, () =>
      replay.service.submit('production-replay-second', replayExported.id, {
        expectedVersion: 3,
      }))).resolves.toMatchObject({ status: 'submitted', version: 4 });
    expect(replay.productionAuthorization.authorize).not.toHaveBeenCalled();
    expect(replay.bankGateway.submit).toHaveBeenCalledOnce();
  });
});
