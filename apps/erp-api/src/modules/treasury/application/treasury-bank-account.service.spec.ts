import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  type ImportTreasuryBankAccountFromMigrationInput,
  TreasuryBankAccountService,
} from './treasury-bank-account.service.js';
import { AttestTreasuryBankAccountDto } from './treasury.dto.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = { inTransaction: () => true } as unknown as ClientSession;
const envelope = {
  dataKeyId: 'treasury-key',
  dataIv: 'A'.repeat(16),
  dataCiphertext: 'B'.repeat(16),
  dataAuthTag: 'C'.repeat(22),
};
const blindIndex = `blind-key-001.${'a'.repeat(43)}`;
const input = {
  ownerType: 'employee' as const, ownerId: 'employee-001', accountName: ' 张三 ',
  account: '6222000000000001', clearingCode: 'CNAPS001', currency: 'CNY' as const,
  approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
};
const migrationInput: ImportTreasuryBankAccountFromMigrationInput = {
  targetId: null, ownerType: 'employee', ownerId: 'employee-001', accountName: '张三',
  account: '6222000000000001', clearingCode: 'CNAPS001', currency: 'CNY',
  version: 1, status: 'active',
  approvalHistoryId: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
  approvalEvidenceChecksum: 'a'.repeat(43), createdAt: '2026-07-01T00:00:00.000Z',
  revokedAt: null,
  migrationEvidenceRef:
    'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/account-001',
  evidenceChecksum: 'e'.repeat(43),
};

function actor(actorType: ActorContext['actorType']): ActorContext {
  return {
    actorType, actorId: 'connector-001', tenantId: tenant.tenantId,
    roleCodes: ['treasury_connector'], scopes: ['erp:treasury:account:attest'],
    departmentIds: [], traceId: 'trace-001',
  };
}

function chain<T>(value: T) {
  const query = {
    sort: vi.fn(), session: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue(value),
  };
  query.sort.mockReturnValue(query);
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function dynamicChain<T>(resolve: () => T) {
  const query = {
    sort: vi.fn(), session: vi.fn(), lean: vi.fn(), exec: vi.fn(() => Promise.resolve(resolve())),
  };
  query.sort.mockReturnValue(query);
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function storedAccount(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    tenantId: tenant.tenantId,
    ownerType: 'employee',
    ownerId: 'employee-001',
    version: 1,
    accountBlindIndexes: [blindIndex],
    approvalEvidenceId: input.approvalEvidenceId,
    approvalReferenceType: 'approval_instance',
    status: 'active',
    supersededById: null,
    revokedAt: null,
    migrationEvidenceRef: null,
    migrationEvidenceChecksum: null,
    ...envelope,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const employees = { findById: vi.fn().mockResolvedValue({ status: 'active' }) };
  const crypto = {
    accountFingerprints: vi.fn().mockReturnValue([blindIndex]),
    protect: vi.fn().mockReturnValue({
      keyId: envelope.dataKeyId,
      iv: envelope.dataIv,
      ciphertext: envelope.dataCiphertext,
      authTag: envelope.dataAuthTag,
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const accounts = {
    findOne: vi.fn()
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null)),
    updateOne: vi.fn(),
    create: vi.fn().mockImplementation((records: readonly Record<string, unknown>[]) =>
      Promise.resolve(records)),
  };
  const approvals = {
    getTreasuryBankAccountDecision: vi.fn().mockResolvedValue(Object.freeze({
      id: input.approvalEvidenceId,
      completedAt: '2026-07-01T00:00:00.000Z',
      approvedBy: 'approver-001',
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      accountName: '张三',
      account: input.account,
      clearingCode: input.clearingCode,
      currency: input.currency,
      formDataHash: 'f'.repeat(43),
    })),
  };
  const boundary = { assertLegacy: vi.fn() };
  const service = new TreasuryBankAccountService(
    idempotency as never, context, employees as never,
    crypto as never, outbox as never, accounts as never,
    approvals as never, boundary as never,
  );
  return {
    context, idempotency, employees, crypto, outbox, accounts, approvals, boundary, service,
  };
}

function assembleMigration() {
  const context = new TenantContextService();
  let record: Record<string, unknown> | null = null;
  let protectedData: Readonly<Record<string, unknown>> | null = null;
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const employees = { findById: vi.fn().mockResolvedValue({ status: 'active' }) };
  const crypto = {
    accountFingerprints: vi.fn().mockReturnValue([blindIndex]),
    protect: vi.fn().mockImplementation((_context: unknown, value: Readonly<Record<string, unknown>>) => {
      protectedData = value;
      return {
        keyId: envelope.dataKeyId,
        iv: envelope.dataIv,
        ciphertext: envelope.dataCiphertext,
        authTag: envelope.dataAuthTag,
      };
    }),
    unprotect: vi.fn().mockImplementation(() => protectedData),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const accounts = {
    findOne: vi.fn().mockImplementation((filter: Readonly<Record<string, unknown>>) =>
      dynamicChain(() => filter.id === undefined ? null : record)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    create: vi.fn().mockImplementation((records: readonly Record<string, unknown>[]) => {
      record = { ...records[0] };
      return Promise.resolve([record]);
    }),
  };
  const approvals = { verifyTreasuryMigrationReference: vi.fn().mockResolvedValue({
    id: migrationInput.approvalHistoryId,
    templateCode: 'treasury_bank_account_attestation',
    completedAt: '2026-06-30T00:00:00.000Z',
    evidenceChecksum: migrationInput.approvalEvidenceChecksum,
  }) };
  const boundary = { assertLegacy: vi.fn() };
  const service = new TreasuryBankAccountService(
    idempotency as never, context, employees as never, crypto as never,
    outbox as never, accounts as never, approvals as never, boundary as never,
  );
  return {
    context, idempotency, service, employees, crypto, outbox, accounts, approvals, boundary,
  };
}

function runAttest(
  store: ReturnType<typeof assemble>,
  value: typeof input = input,
  actorContext: ActorContext = actor('service'),
) {
  return store.context.run({ tenant, actor: actorContext }, () =>
    store.service.attest('treasury-account-test', value));
}

function runMigration(
  store: ReturnType<typeof assembleMigration>,
  value: ImportTreasuryBankAccountFromMigrationInput = migrationInput,
) {
  return store.context.run({
    tenant: { tenantId: tenant.tenantId, source: 'service_identity' },
    actor: {
      ...actor('service'),
      scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
    },
  }, () => store.service.importFromMigration('treasury-account-migration-test', value));
}

describe('TreasuryBankAccountService', () => {
  it('在线登记接受全局 ValidationPipe 生成的官方 DTO 实例', async () => {
    const store = assemble();
    const dto = Object.assign(new AttestTreasuryBankAccountDto(), input);
    await expect(runAttest(store, dto)).resolves.toMatchObject({
      ownerType: 'employee',
      ownerId: 'employee-001',
      version: 1,
      status: 'active',
    });
  });

  it('迁移账户使用历史审批、独立密文和盲索引且事件不含账号', async () => {
    const store = assembleMigration();
    const result = await store.context.run({
      tenant: { tenantId: tenant.tenantId, source: 'service_identity' },
      actor: {
        ...actor('service'),
        scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
      },
    }, () => store.service.importFromMigration('treasury-account-migration-001', migrationInput));
    expect(result).toMatchObject({
      ownerType: 'employee', ownerId: 'employee-001', version: 1, status: 'active',
    });
    expect(store.accounts.create).toHaveBeenCalledWith([
      expect.objectContaining({
        approvalReferenceType: 'legacy_history',
        migrationEvidenceRef: migrationInput.migrationEvidenceRef,
        dataCiphertext: envelope.dataCiphertext,
      }),
    ], { session });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'treasury.bank_account.migrated',
      data: { ownerType: 'employee', version: 1, status: 'active' },
    }), session);
    expect(JSON.stringify(store.accounts.create.mock.calls)).not.toContain(migrationInput.account);
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain(migrationInput.account);
  });

  it('账户迁移拒绝普通用户，即使其持有迁移 Scope', async () => {
    const store = assembleMigration();
    await expect(store.context.run({ tenant, actor: {
      ...actor('user'), scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
    } }, () => store.service.importFromMigration(
      'treasury-account-migration-user', migrationInput,
    ))).rejects.toThrow('受信任服务身份');
    expect(store.approvals.verifyTreasuryMigrationReference).not.toHaveBeenCalled();
    expect(store.accounts.create).not.toHaveBeenCalled();
  });

  it('账户迁移重放会解密并逐项验证不可变证据', async () => {
    const store = assembleMigration();
    const trusted = {
      tenant: { tenantId: tenant.tenantId, source: 'service_identity' as const },
      actor: {
        ...actor('service'), scopes: ['erp:migration:execute', 'erp:treasury:migration:write'],
      },
    };
    const imported = await store.context.run(trusted, () =>
      store.service.importFromMigration('treasury-account-migration-create', migrationInput));
    const replayed = await store.context.run(trusted, () => store.service.importFromMigration(
      'treasury-account-migration-replay', { ...migrationInput, targetId: imported.id },
    ));
    expect(replayed).toEqual(imported);
    expect(store.accounts.create).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
    expect(store.crypto.unprotect).toHaveBeenCalledOnce();
  });

  it('可信服务使用当前租户登记密文账户版本，事件和响应不含账号', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor('service') }, () =>
      store.service.attest('treasury-account-001', input));
    expect(store.employees.findById).toHaveBeenCalledWith('employee-001', session);
    expect(store.crypto.protect).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', resourceType: 'bank_account', version: 1,
    }), {
      accountName: '张三', account: '6222000000000001',
      clearingCode: 'CNAPS001', currency: 'CNY',
    });
    expect(JSON.stringify(store.accounts.create.mock.calls)).not.toContain('6222000000000001');
    expect(JSON.stringify(result)).not.toContain('6222000000000001');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('6222000000000001');
  });

  it('即使拥有 Scope，普通用户也不能登记银行账户', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: actor('user') }, () =>
      store.service.attest('treasury-account-001', input))).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_SERVICE_REQUIRED' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('组织付款账户只能绑定当前可信租户', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: actor('service') }, () =>
      store.service.attest('treasury-account-001', {
        ...input, ownerType: 'organization', ownerId: 'tenant-002',
      }))).rejects.toMatchObject({
      response: { code: 'TREASURY_ORGANIZATION_OWNER_INVALID' },
    });
    expect(store.accounts.create).not.toHaveBeenCalled();
  });

  it('同一主体新版本先在事务中撤销旧活动版本再创建，避免双活动账号', async () => {
    const store = assemble();
    store.accounts.findOne.mockReset();
    store.accounts.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(storedAccount()))
      .mockReturnValueOnce(chain(storedAccount()));
    store.accounts.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const result = await store.context.run({ tenant, actor: actor('service') }, () =>
      store.service.attest('treasury-account-002', input));
    const updateCall = JSON.stringify(store.accounts.updateOne.mock.calls);
    expect(updateCall).toContain('"tenantId":"tenant-001"');
    expect(updateCall).toContain('"id":"01J8ZQK7V0A2M4N6P8R0T2W4Y7"');
    expect(updateCall).toContain('"status":"revoked"');
    expect(updateCall).toContain('"supersededById"');
    expect(store.accounts.updateOne).toHaveBeenCalledOnce();
    expect(result.version).toBe(2);
  });

  it.each([
    ['在线登记', () => {
      const store = assemble();
      store.boundary.assertLegacy.mockImplementation(() => {
        throw Object.assign(new Error('已迁移'), {
          response: { code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM' },
        });
      });
      return { promise: runAttest(store), store };
    }],
    ['历史迁移', () => {
      const store = assembleMigration();
      store.boundary.assertLegacy.mockImplementation(() => {
        throw Object.assign(new Error('已迁移'), {
          response: { code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM' },
        });
      });
      return { promise: runMigration(store), store };
    }],
  ] as const)('external 边界在%s进入事务或审批前关闭旧事实源', async (_label, create) => {
    const { promise, store } = create();
    await expect(promise).rejects.toMatchObject({
      response: { code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('在线登记先校验 Scope，再检查系统模式', async () => {
    const store = assemble();
    await expect(runAttest(store, input, {
      ...actor('service'), scopes: [],
    })).rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    expect(store.boundary.assertLegacy).not.toHaveBeenCalled();
  });

  it.each([
    ['多余字段', { ...input, unexpected: true }],
    ['非法审批号', { ...input, approvalEvidenceId: 'invalid' }],
    ['非法主体类型', { ...input, ownerType: 'supplier' }],
    ['非法主体编号', { ...input, ownerId: '/invalid' }],
    ['空户名', { ...input, accountName: '  ' }],
    ['超长户名', { ...input, accountName: '张'.repeat(141) }],
    ['控制字符户名', { ...input, accountName: '张三\u0000' }],
    ['非法账号', { ...input, account: '1234' }],
    ['非法清算号', { ...input, clearingCode: 'cnaps001' }],
    ['非法币种', { ...input, currency: 'USD' }],
    ['非字符串字段', { ...input, accountName: 1 }],
  ] as const)('在线登记拒绝%s', async (_label, invalid) => {
    const store = assemble();
    await expect(runAttest(store, invalid as never)).rejects.toMatchObject({
      response: { code: 'TREASURY_BANK_ACCOUNT_INVALID' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('在线登记拒绝访问器和自定义原型输入', async () => {
    const store = assemble();
    const accessor = { ...input };
    Object.defineProperty(accessor, 'accountName', { get: () => '张三', enumerable: true });
    await expect(runAttest(store, accessor)).rejects.toMatchObject({
      response: { code: 'TREASURY_BANK_ACCOUNT_INVALID' },
    });
    const inherited = { ...input };
    Object.setPrototypeOf(inherited, { privileged: true });
    await expect(runAttest(store, inherited)).rejects.toMatchObject({
      response: { code: 'TREASURY_BANK_ACCOUNT_INVALID' },
    });
  });

  it('在线登记必须运行于活动事务', async () => {
    const store = assemble();
    store.idempotency.execute.mockImplementation(async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler({ inTransaction: () => false } as unknown as ClientSession));
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_TRANSACTION_REQUIRED' },
    });
    expect(store.approvals.getTreasuryBankAccountDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['id', '01J8ZQK7V0A2M4N6P8R0T2W4Y5'],
    ['ownerType', 'organization'],
    ['ownerId', 'employee-002'],
    ['accountName', '李四'],
    ['account', '6222000000000002'],
    ['clearingCode', 'CNAPS002'],
    ['currency', 'USD'],
    ['approvedBy', '/invalid'],
    ['formDataHash', 'invalid'],
    ['completedAt', 'invalid'],
  ] as const)('审批终态字段 %s 不一致时拒绝登记', async (field, value) => {
    const store = assemble();
    store.approvals.getTreasuryBankAccountDecision.mockReset();
    store.approvals.getTreasuryBankAccountDecision.mockResolvedValue({
      id: input.approvalEvidenceId,
      completedAt: '2026-07-01T00:00:00.000Z',
      approvedBy: 'approver-001',
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      accountName: '张三',
      account: input.account,
      clearingCode: input.clearingCode,
      currency: input.currency,
      formDataHash: 'f'.repeat(43),
      [field]: value,
    });
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_APPROVAL_MISMATCH' },
    });
    expect(store.crypto.accountFingerprints).not.toHaveBeenCalled();
  });

  it.each([
    { fingerprints: [] },
    { fingerprints: {} },
    { fingerprints: [blindIndex, blindIndex] },
    { fingerprints: ['invalid'] },
    { fingerprints: Object.assign(new Array<string>(1), {}) },
    {
      fingerprints: Array.from(
        { length: 9 },
        (_value, index) => `blind-${index}.${'a'.repeat(43)}`,
      ),
    },
  ])('拒绝非法或不闭合的盲索引集合 %#', async ({ fingerprints }) => {
    const store = assemble();
    store.crypto.accountFingerprints.mockReturnValue(fingerprints);
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(store.accounts.findOne).not.toHaveBeenCalled();
  });

  it('拒绝把活动账号绑定到其他主体', async () => {
    const store = assemble();
    store.accounts.findOne.mockReset();
    store.accounts.findOne.mockReturnValueOnce(chain(storedAccount({ ownerId: 'employee-002' })));
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACTIVE_ACCOUNT_DUPLICATE' },
    });
  });

  it.each([
    ['错误租户', { tenantId: 'tenant-002' }],
    ['非法版本', { version: 0 }],
    ['非法活动终态', { revokedAt: new Date('2026-07-01T00:00:00.000Z') }],
    ['非法密文', { dataIv: 'invalid' }],
    ['迁移证据缺一', { migrationEvidenceChecksum: 'e'.repeat(43) }],
  ] as const)('拒绝数据库返回的%s', async (_label, corrupt) => {
    const store = assemble();
    store.accounts.findOne.mockReset();
    store.accounts.findOne.mockReturnValueOnce(chain(storedAccount(corrupt)));
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(store.accounts.updateOne).not.toHaveBeenCalled();
  });

  it.each([null, { status: 'terminated' }])(
    '活动员工主数据无效时拒绝账户登记 %#',
    async (employee) => {
      const store = assemble();
      store.employees.findById.mockResolvedValue(employee);
      await expect(runAttest(store)).rejects.toMatchObject({
        response: { code: 'TREASURY_EMPLOYEE_NOT_ACTIVE' },
      });
    },
  );

  it('当前版本并发撤销失败时不创建新版本', async () => {
    const store = assemble();
    store.accounts.findOne.mockReset();
    store.accounts.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(storedAccount()))
      .mockReturnValueOnce(chain(storedAccount()));
    store.accounts.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_VERSION_CONFLICT' },
    });
    expect(store.accounts.create).not.toHaveBeenCalled();
  });

  it('活动账号、主体当前版本与最新版本必须形成同一闭包', async () => {
    const stale = assemble();
    stale.accounts.findOne.mockReset();
    stale.accounts.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(storedAccount()))
      .mockReturnValueOnce(chain(storedAccount({
        id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
        version: 2,
        status: 'revoked',
        revokedAt: new Date('2026-07-02T00:00:00.000Z'),
      })));
    await expect(runAttest(stale)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(stale.crypto.protect).not.toHaveBeenCalled();

    const split = assemble();
    split.accounts.findOne.mockReset();
    split.accounts.findOne
      .mockReturnValueOnce(chain(storedAccount()))
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null));
    await expect(runAttest(split)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(split.crypto.protect).not.toHaveBeenCalled();
  });

  it('版本上限或持久化返回不闭合时拒绝出站事件', async () => {
    const overflow = assemble();
    overflow.accounts.findOne.mockReset();
    overflow.accounts.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(storedAccount({
        version: 1_000,
        status: 'revoked',
        revokedAt: new Date('2026-07-02T00:00:00.000Z'),
      })));
    await expect(runAttest(overflow)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });

    const missing = assemble();
    missing.accounts.create.mockResolvedValue([]);
    await expect(runAttest(missing)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(missing.outbox.append).not.toHaveBeenCalled();

    const mismatched = assemble();
    mismatched.accounts.create.mockImplementation(
      (records: readonly Record<string, unknown>[]) =>
        Promise.resolve([{ ...records[0], ownerId: 'employee-002' }]),
    );
    await expect(runAttest(mismatched)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(mismatched.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    { keyId: '', iv: 'A'.repeat(16), ciphertext: 'B', authTag: 'C'.repeat(22) },
    { keyId: 'key', iv: 'invalid', ciphertext: 'B', authTag: 'C'.repeat(22) },
    { keyId: 'key', iv: 'A'.repeat(16), ciphertext: '', authTag: 'C'.repeat(22) },
    { keyId: 'key', iv: 'A'.repeat(16), ciphertext: 'B', authTag: 'invalid' },
    {
      keyId: 'key',
      iv: 'A'.repeat(16),
      ciphertext: 'B',
      authTag: 'C'.repeat(22),
      unexpected: true,
    },
  ])('拒绝非法加密信封 %#', async (protectedValue) => {
    const store = assemble();
    store.crypto.protect.mockReturnValue(protectedValue);
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(store.accounts.create).not.toHaveBeenCalled();
  });

  it('Mongo 唯一键冲突映射为稳定业务错误', async () => {
    const store = assemble();
    store.accounts.create.mockRejectedValue({ code: 11_000 });
    await expect(runAttest(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_UNIQUE_CONFLICT' },
    });
  });

  it.each([
    ['证据摘要', { approvalEvidenceChecksum: 'b'.repeat(43) }],
    ['审批时间线', { createdAt: '2026-06-01T00:00:00.000Z' }],
  ] as const)('迁移拒绝不一致的%s', async (_label, patch) => {
    const store = assembleMigration();
    await expect(runMigration(store, { ...migrationInput, ...patch })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_APPROVAL_INVALID' },
    });
    expect(store.accounts.create).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'history-other' },
    { templateCode: 'payroll_period_approval' },
    { evidenceChecksum: 'invalid' },
    { completedAt: 'invalid' },
    { unexpected: true },
  ])('迁移拒绝不闭合的审批服务投影 %#', async (patch) => {
    const store = assembleMigration();
    store.approvals.verifyTreasuryMigrationReference.mockResolvedValue({
      id: migrationInput.approvalHistoryId,
      templateCode: 'treasury_bank_account_attestation',
      completedAt: '2026-06-30T00:00:00.000Z',
      evidenceChecksum: migrationInput.approvalEvidenceChecksum,
      ...patch,
    });
    await expect(runMigration(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(store.accounts.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['多余字段', { ...migrationInput, unexpected: true }],
    ['非法目标', { ...migrationInput, targetId: 'invalid' }],
    ['非法版本', { ...migrationInput, version: 0 }],
    ['活动账户带撤销时间', {
      ...migrationInput, revokedAt: '2026-07-02T00:00:00.000Z',
    }],
    ['撤销账户缺撤销时间', { ...migrationInput, status: 'revoked' }],
    ['非法证据引用', { ...migrationInput, migrationEvidenceRef: 'invalid' }],
  ] as const)('迁移拒绝%s', async (_label, invalid) => {
    const store = assembleMigration();
    await expect(runMigration(store, invalid as never)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_INPUT_INVALID' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('迁移拒绝倒置时间线和非标准 UTC 时间', async () => {
    const store = assembleMigration();
    await expect(runMigration(store, {
      ...migrationInput,
      status: 'revoked',
      revokedAt: '2026-06-30T23:59:59.999Z',
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_TIME_INVALID' },
    });
    await expect(runMigration(store, {
      ...migrationInput,
      createdAt: '2026-07-01',
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_TIME_INVALID' },
    });
  });

  it('迁移活动账户拒绝重复账号和主体活动版本', async () => {
    const duplicate = assembleMigration();
    duplicate.accounts.findOne.mockImplementationOnce(() => chain(null));
    duplicate.accounts.findOne.mockImplementationOnce(() => chain(storedAccount()));
    await expect(runMigration(duplicate)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_ACTIVE_DUPLICATE' },
    });

    const current = assembleMigration();
    current.accounts.findOne.mockImplementationOnce(() => chain(null));
    current.accounts.findOne.mockImplementationOnce(() => chain(null));
    current.accounts.findOne.mockImplementationOnce(() => chain(storedAccount()));
    await expect(runMigration(current)).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_ACTIVE_CONFLICT' },
    });
  });

  it('迁移后续版本要求前序已撤销且关联写入成功', async () => {
    const latest = storedAccount({
      status: 'revoked',
      revokedAt: new Date('2026-07-01T01:00:00.000Z'),
    });
    const invalid = assembleMigration();
    invalid.accounts.findOne.mockImplementationOnce(() => chain(storedAccount()));
    await expect(runMigration(invalid, {
      ...migrationInput, version: 2,
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_VERSION_INVALID' },
    });

    const conflict = assembleMigration();
    conflict.accounts.findOne.mockImplementationOnce(() => chain(latest));
    conflict.accounts.findOne.mockImplementationOnce(() => chain(null));
    conflict.accounts.findOne.mockImplementationOnce(() => chain(null));
    conflict.accounts.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(runMigration(conflict, {
      ...migrationInput, version: 2,
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_VERSION_CONFLICT' },
    });
  });

  it('迁移重放目标不存在或不可变证据变化时拒绝覆盖', async () => {
    const missing = assembleMigration();
    await expect(runMigration(missing, {
      ...migrationInput, targetId: input.approvalEvidenceId,
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_IMMUTABLE' },
    });

    const changed = assembleMigration();
    const created = await runMigration(changed);
    await expect(runMigration(changed, {
      ...migrationInput,
      targetId: created.id,
      accountName: '李四',
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_MIGRATION_IMMUTABLE' },
    });

    const corrupt = assembleMigration();
    const imported = await runMigration(corrupt);
    corrupt.accounts.findOne.mockImplementationOnce(() => chain({
      ...storedAccount({ id: imported.id }),
      tenantId: 'tenant-002',
    }));
    await expect(runMigration(corrupt, {
      ...migrationInput,
      targetId: imported.id,
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ACCOUNT_INTEGRITY_FAILED' },
    });
    expect(corrupt.crypto.unprotect).not.toHaveBeenCalled();
  });
});
