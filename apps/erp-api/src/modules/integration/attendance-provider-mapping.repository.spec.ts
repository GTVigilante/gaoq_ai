import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import { AttendanceProviderMappingRepository } from './attendance-provider-mapping.repository.js';
import { OrgPushError } from './org-push.adapter.js';

const TENANT_ID = 'tenant-001';
const EMPLOYEE_ID = 'employee-001';
const EXTERNAL_EMPLOYEE_ID = 'external-user-001';
const FINGERPRINT_A = `blind-key-001.${'A'.repeat(43)}`;
const FINGERPRINT_B = `blind-key-002.${'B'.repeat(43)}`;
const PROTECTED_ID = Object.freeze({
  keyId: 'enc-key-001',
  iv: 'A'.repeat(16),
  ciphertext: 'encrypted_external_user',
  authTag: 'B'.repeat(22),
});

interface FixtureOptions {
  readonly existing?: unknown;
  readonly existingResult?: unknown;
  readonly fingerprints?: unknown;
  readonly protectedId?: unknown;
  readonly stateResult?: unknown;
  readonly createdResult?:
    | readonly unknown[]
    | ((rows: readonly unknown[]) => unknown);
  readonly inTransaction?: () => boolean;
}

function fixture(options: FixtureOptions = {}) {
  const inTransaction = vi.fn<() => boolean>(
    options.inTransaction ?? (() => true),
  );
  const session = {
    inTransaction,
  } as unknown as ClientSession;
  const stateUpdate = vi.fn<
    (filter: unknown, update: unknown, writeOptions: unknown) => Promise<unknown>
  >().mockResolvedValue(
    options.stateResult ?? {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 0,
      upsertedCount: 0,
    },
  );
  const exec = vi.fn<() => Promise<unknown>>().mockResolvedValue(
    options.existingResult ??
      (options.existing === undefined ? [] : [options.existing]),
  );
  const lean = vi.fn<() => { readonly exec: typeof exec }>(() => ({ exec }));
  const bindSession = vi.fn<
    (value: unknown) => { readonly lean: typeof lean }
  >(() => ({ lean }));
  const limit = vi.fn<
    (value: number) => { readonly session: typeof bindSession }
  >(() => ({ session: bindSession }));
  const find = vi.fn<
    (filter: unknown, projection: unknown) => { readonly limit: typeof limit }
  >(() => ({ limit }));
  const create = vi.fn<
    (rows: readonly unknown[], writeOptions: unknown) => Promise<unknown>
  >((rows) => {
    if (typeof options.createdResult === 'function') {
      return Promise.resolve(options.createdResult(rows));
    }
    return Promise.resolve(options.createdResult ?? rows);
  });
  const providerFingerprints = vi.fn<
    (
      tenantId: unknown,
      namespace: unknown,
      providerCode: unknown,
      externalEmployeeId: unknown,
    ) => unknown
  >().mockReturnValue(options.fingerprints ?? [FINGERPRINT_A, FINGERPRINT_B]);
  const protect = vi.fn<
    (context: unknown, externalEmployeeId: unknown) => unknown
  >().mockReturnValue(options.protectedId ?? PROTECTED_ID);
  const repository = new AttendanceProviderMappingRepository(
    { create, find } as never,
    { updateOne: stateUpdate } as never,
    { protect, providerFingerprints } as unknown as AttendanceDataCryptoService,
  );
  return {
    bindSession,
    create,
    exec,
    find,
    inTransaction,
    lean,
    limit,
    protect,
    providerFingerprints,
    repository,
    session,
    stateUpdate,
  };
}

async function ensure(
  value: ReturnType<typeof fixture>,
  overrides: Partial<{
    readonly tenantId: unknown;
    readonly providerCode: unknown;
    readonly employeeId: unknown;
    readonly externalEmployeeId: unknown;
    readonly session: unknown;
  }> = {},
): Promise<void> {
  await value.repository.ensure(
    overrides.tenantId ?? TENANT_ID,
    overrides.providerCode ?? 'dingtalk',
    overrides.employeeId ?? EMPLOYEE_ID,
    overrides.externalEmployeeId ?? EXTERNAL_EMPLOYEE_ID,
    overrides.session ?? value.session,
  );
}

function expectOrgPushError(
  error: unknown,
  code: string,
  category: 'retryable' | 'business' | 'conflict',
): void {
  expect(error).toBeInstanceOf(OrgPushError);
  expect(error).toMatchObject({ code, category });
}

describe('AttendanceProviderMappingRepository', () => {
  it('在活动事务内以最小投影建立加密双向唯一映射', async () => {
    const value = fixture({
      stateResult: {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 1,
      },
    });

    await ensure(value);

    expect(value.inTransaction).toHaveBeenCalledOnce();
    expect(value.providerFingerprints).toHaveBeenCalledWith(
      TENANT_ID,
      'employee',
      'dingtalk',
      EXTERNAL_EMPLOYEE_ID,
    );
    const stateCall = value.stateUpdate.mock.calls[0];
    const stateUpdate = stateCall?.[1] as {
      readonly $setOnInsert: {
        readonly id: string;
        readonly tenantId: string;
        readonly providerCode: string;
        readonly status: string;
      };
    };
    expect(stateCall?.[0]).toEqual({
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
    });
    expect(stateUpdate.$setOnInsert).toMatchObject({
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      status: 'disabled',
    });
    expect(stateUpdate.$setOnInsert.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(stateCall?.[2]).toEqual({
      upsert: true,
      session: value.session,
      runValidators: true,
    });
    expect(value.find).toHaveBeenCalledWith(
      {
        tenantId: TENANT_ID,
        providerCode: 'dingtalk',
        $or: [
          { employeeId: EMPLOYEE_ID },
          { externalIdBlindIndexes: { $in: [FINGERPRINT_A, FINGERPRINT_B] } },
        ],
      },
      {
        tenantId: 1,
        providerCode: 1,
        employeeId: 1,
        externalIdBlindIndexes: 1,
        status: 1,
        _id: 0,
      },
    );
    expect(value.limit).toHaveBeenCalledWith(2);
    expect(value.bindSession).toHaveBeenCalledWith(value.session);
    const context = value.protect.mock.calls[0]?.[0] as {
      readonly tenantId: string;
      readonly resourceType: string;
      readonly resourceId: string;
    };
    expect(context).toMatchObject({
      tenantId: TENANT_ID,
      resourceType: 'provider_mapping',
    });
    expect(context.resourceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(value.protect).toHaveBeenCalledWith(context, EXTERNAL_EMPLOYEE_ID);
    expect(value.create).toHaveBeenCalledWith(
      [{
        id: context.resourceId,
        tenantId: TENANT_ID,
        providerCode: 'dingtalk',
        employeeId: EMPLOYEE_ID,
        externalIdBlindIndexes: [FINGERPRINT_A, FINGERPRINT_B],
        externalIdKeyId: PROTECTED_ID.keyId,
        externalIdIv: PROTECTED_ID.iv,
        externalIdCiphertext: PROTECTED_ID.ciphertext,
        externalIdAuthTag: PROTECTED_ID.authTag,
        status: 'active',
      }],
      { session: value.session },
    );
    expect(JSON.stringify([
      value.stateUpdate.mock.calls,
      value.find.mock.calls,
      value.create.mock.calls,
    ])).not.toContain(EXTERNAL_EMPLOYEE_ID);
  });

  it('同一员工与外部标识的活动映射按盲索引幂等复用', async () => {
    const value = fixture({
      existing: {
        tenantId: TENANT_ID,
        providerCode: 'dingtalk',
        employeeId: EMPLOYEE_ID,
        externalIdBlindIndexes: [FINGERPRINT_B],
        status: 'active',
      },
    });

    await ensure(value);

    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it.each([
    ['外部标识已属于另一员工', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: 'employee-other',
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'active',
    }],
    ['员工已绑定另一外部标识', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [`blind-key-003.${'C'.repeat(43)}`],
      status: 'active',
    }],
    ['既有映射已停用', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'disabled',
    }],
  ])('%s时立即进入冲突而不是依赖唯一索引重试', async (_name, existing) => {
    const value = fixture({ existing });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_CONFLICT',
      'conflict',
    );
    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it('员工与外部标识命中不同记录时按双向冲突失败关闭', async () => {
    const value = fixture({
      existingResult: [
        {
          tenantId: TENANT_ID,
          providerCode: 'dingtalk',
          employeeId: EMPLOYEE_ID,
          externalIdBlindIndexes: [FINGERPRINT_B],
          status: 'active',
        },
        {
          tenantId: TENANT_ID,
          providerCode: 'dingtalk',
          employeeId: 'employee-other',
          externalIdBlindIndexes: [FINGERPRINT_A],
          status: 'active',
        },
      ],
    });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_CONFLICT',
      'conflict',
    );
    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it('映射查询返回非数组时按损坏投影失败关闭', async () => {
    const value = fixture({
      existingResult: {
        tenantId: TENANT_ID,
        providerCode: 'dingtalk',
        employeeId: EMPLOYEE_ID,
      },
    });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_RECORD_INVALID',
      'conflict',
    );
    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it.each([
    ['跨租户投影', {
      tenantId: 'tenant-other',
      providerCode: 'dingtalk',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'active',
    }],
    ['跨平台投影', {
      tenantId: TENANT_ID,
      providerCode: 'feishu',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'active',
    }],
    ['未知字段', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'active',
      secret: 'unexpected',
    }],
    ['非法员工标识', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: { $ne: null },
      externalIdBlindIndexes: [FINGERPRINT_A],
      status: 'active',
    }],
    ['空盲索引', {
      tenantId: TENANT_ID,
      providerCode: 'dingtalk',
      employeeId: EMPLOYEE_ID,
      externalIdBlindIndexes: [],
      status: 'active',
    }],
  ])('拒绝损坏的%s且不创建映射', async (_name, existing) => {
    const value = fixture({ existing });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_RECORD_INVALID',
      'conflict',
    );
    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it.each([
    ['租户', { tenantId: { $ne: null } }],
    ['平台', { providerCode: 'op' }],
    ['员工', { employeeId: '' }],
    ['外部标识', { externalEmployeeId: '@invalid' }],
  ])('在访问密钥和数据库前拒绝非法%s输入', async (_name, overrides) => {
    const value = fixture();

    const error = await ensure(value, overrides).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_INPUT_INVALID',
      'conflict',
    );
    expect(value.providerFingerprints).not.toHaveBeenCalled();
    expect(value.stateUpdate).not.toHaveBeenCalled();
    expect(value.find).not.toHaveBeenCalled();
  });

  it.each([
    ['非事务会话', { inTransaction: () => false }],
    ['损坏会话', { inTransaction: () => { throw new Error('SESSION_INVALID'); } }],
  ])('%s在密钥和数据库访问前失败关闭', async (_name, sessionValue) => {
    const value = fixture();

    const error = await ensure(value, {
      session: sessionValue,
    }).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_TRANSACTION_REQUIRED',
      'conflict',
    );
    expect(value.providerFingerprints).not.toHaveBeenCalled();
    expect(value.stateUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['非数组', 'invalid'],
    ['空集合', []],
    ['重复集合', [FINGERPRINT_A, FINGERPRINT_A]],
    ['超出密钥环上限', [
      FINGERPRINT_A,
      FINGERPRINT_B,
      `blind-key-003.${'C'.repeat(43)}`,
      `blind-key-004.${'D'.repeat(43)}`,
      `blind-key-005.${'E'.repeat(43)}`,
      `blind-key-006.${'F'.repeat(43)}`,
    ]],
    ['非法编码', ['plaintext-external-user']],
  ])('拒绝密钥服务返回的%s盲索引', async (_name, fingerprints) => {
    const value = fixture({ fingerprints });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_RECORD_INVALID',
      'conflict',
    );
    expect(value.stateUpdate).not.toHaveBeenCalled();
    expect(value.find).not.toHaveBeenCalled();
  });

  it.each([
    ['未确认写入', { acknowledged: false, matchedCount: 1, upsertedCount: 0 }],
    ['无匹配也无新增', { acknowledged: true, matchedCount: 0, upsertedCount: 0 }],
    ['同时匹配与新增', { acknowledged: true, matchedCount: 1, upsertedCount: 1 }],
    ['非法匹配计数', { acknowledged: true, matchedCount: -1, upsertedCount: 0 }],
    ['缺少新增计数', { acknowledged: true, matchedCount: 1 }],
  ])('Provider 状态%s时不继续建立映射', async (_name, stateResult) => {
    const value = fixture({ stateResult });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_WRITE_UNAVAILABLE',
      'retryable',
    );
    expect(value.find).not.toHaveBeenCalled();
    expect(value.protect).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it.each([
    ['非对象', 'invalid'],
    ['未知字段', { ...PROTECTED_ID, plaintext: EXTERNAL_EMPLOYEE_ID }],
    ['非法 Key ID', { ...PROTECTED_ID, keyId: 'key@invalid' }],
    ['非法 IV', { ...PROTECTED_ID, iv: 'short' }],
    ['空密文', { ...PROTECTED_ID, ciphertext: '' }],
    ['非法 AuthTag', { ...PROTECTED_ID, authTag: 'short' }],
  ])('拒绝加密服务返回的%s信封', async (_name, protectedId) => {
    const value = fixture({ protectedId });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_RECORD_INVALID',
      'conflict',
    );
    expect(value.create).not.toHaveBeenCalled();
  });

  it.each([
    ['空结果', []],
    ['多行结果', (rows: readonly unknown[]) => [rows[0], rows[0]]],
    ['错位租户', (rows: readonly unknown[]) => [{
      ...(rows[0] as object),
      tenantId: 'tenant-other',
    }]],
    ['错位盲索引', (rows: readonly unknown[]) => [{
      ...(rows[0] as object),
      externalIdBlindIndexes: [FINGERPRINT_A],
    }]],
    ['错位密文', (rows: readonly unknown[]) => [{
      ...(rows[0] as object),
      externalIdCiphertext: 'different',
    }]],
  ])('数据库创建返回%s时事务失败关闭', async (_name, createdResult) => {
    const value = fixture({ createdResult });

    const error = await ensure(value).catch((caught: unknown) => caught);

    expectOrgPushError(
      error,
      'ORG_PROVISIONING_ATTENDANCE_MAPPING_WRITE_UNAVAILABLE',
      'retryable',
    );
  });

  it.each([
    ['状态写入', 'state'],
    ['映射查询', 'find'],
    ['映射创建', 'create'],
  ])('%s数据库异常保留原错误供上层稳定分类', async (_name, operation) => {
    const value = fixture();
    const failure = new Error('MONGODB_UNAVAILABLE');
    if (operation === 'state') value.stateUpdate.mockRejectedValueOnce(failure);
    if (operation === 'find') value.exec.mockRejectedValueOnce(failure);
    if (operation === 'create') value.create.mockRejectedValueOnce(failure);

    await expect(ensure(value)).rejects.toBe(failure);
  });
});
