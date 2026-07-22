import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  type ImportTreasuryBankAccountFromMigrationInput,
  TreasuryBankAccountService,
} from './treasury-bank-account.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
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
    accountFingerprints: vi.fn().mockReturnValue(['blind-001.a'.padEnd(53, 'a')]),
    protect: vi.fn().mockReturnValue({ keyId: 'key', iv: 'iv', ciphertext: 'cipher', authTag: 'tag' }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const accounts = {
    findOne: vi.fn()
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain(null)),
    updateOne: vi.fn(), create: vi.fn().mockResolvedValue([]),
  };
  const service = new TreasuryBankAccountService(
    idempotency as never, context, employees as never,
    crypto as never, outbox as never, accounts as never,
  );
  return { context, idempotency, employees, crypto, outbox, accounts, service };
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
    accountFingerprints: vi.fn().mockReturnValue([`blind-key-001.${'a'.repeat(43)}`]),
    protect: vi.fn().mockImplementation((_context: unknown, value: Readonly<Record<string, unknown>>) => {
      protectedData = value;
      return { keyId: 'key', iv: 'iv', ciphertext: 'cipher', authTag: 'tag' };
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
      return Promise.resolve([]);
    }),
  };
  const approvals = { verifyTreasuryMigrationReference: vi.fn().mockResolvedValue({
    id: migrationInput.approvalHistoryId,
    templateCode: 'treasury_bank_account_attestation',
    completedAt: '2026-06-30T00:00:00.000Z',
    evidenceChecksum: migrationInput.approvalEvidenceChecksum,
  }) };
  const service = new TreasuryBankAccountService(
    idempotency as never, context, employees as never, crypto as never,
    outbox as never, accounts as never, approvals as never,
  );
  return { context, service, employees, crypto, outbox, accounts, approvals };
}

describe('TreasuryBankAccountService', () => {
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
        dataCiphertext: 'cipher',
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
      .mockReturnValueOnce(chain({ id: 'old-account-001', status: 'active' }))
      .mockReturnValueOnce(chain({ version: 1, status: 'active' }));
    store.accounts.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const result = await store.context.run({ tenant, actor: actor('service') }, () =>
      store.service.attest('treasury-account-002', input));
    const updateCall = JSON.stringify(store.accounts.updateOne.mock.calls);
    expect(updateCall).toContain('"tenantId":"tenant-001"');
    expect(updateCall).toContain('"id":"old-account-001"');
    expect(updateCall).toContain('"status":"revoked"');
    expect(updateCall).toContain('"supersededById"');
    expect(store.accounts.updateOne).toHaveBeenCalledOnce();
    expect(result.version).toBe(2);
  });
});
