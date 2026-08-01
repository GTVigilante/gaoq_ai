import type { Connection, Model } from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../identity/access-profile.repository.js';
import type { ExternalIdentityRepository } from '../identity/external-identity.repository.js';
import type { OrgEmployeeDocument } from '../org/persistence/org.schemas.js';
import type { OrgEmployeeProvisioningRequestDocument } from './org-employee-provisioning.schema.js';
import { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';
import type { OrgExternalVersionStateDocument } from './org-delivery.schemas.js';
import type { OrgPlatformCredentialService } from './org-platform-credential.service.js';
import type { OrgProvisioningCryptoService } from './org-provisioning-crypto.service.js';
import { OrgPushAdapterRegistry, OrgPushError } from './org-push.adapter.js';
import type { AttendanceProviderMappingRepository } from './attendance-provider-mapping.repository.js';

const trusted = {
  tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
  actor: {
    tenantId: 'tenant-001',
    actorType: 'user' as const,
    actorId: 'operator-001',
    roleCodes: ['integration-admin'],
    scopes: ['erp:integration:org_provisioning:write'],
    departmentIds: ['department-001'],
    traceId: 'trace-001',
  },
};

const payload = {
  employeeId: 'employee-001',
  channel: 'feishu' as const,
  contact: { email: 'person@example.com' },
};

const query = (value: unknown) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

const claimedRequest = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  tenantId: 'tenant-001',
  requestId: '01K00000000000000000000000',
  employeeId: 'employee-001',
  channel: 'feishu',
  idempotencyKey: 'idempotency-key-001',
  payloadKeyId: 'key-active-001',
  payloadIv: 'b'.repeat(16),
  payloadCiphertext: 'ciphertext',
  payloadAuthTag: 'c'.repeat(22),
  attempts: 0,
  sensitiveExpiresAt: new Date(Date.now() + 10 * 60_000),
  ...overrides,
});

function assemble() {
  const context = new TenantContextService();
  const requestFindOne = vi.fn().mockReturnValue(query(null));
  const requestFindOneAndUpdate = vi.fn().mockReturnValue(query(null));
  const requestCreate = vi.fn().mockResolvedValue({});
  const requestUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const requestUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
  const requests = {
    findOne: requestFindOne,
    findOneAndUpdate: requestFindOneAndUpdate,
    create: requestCreate,
    updateOne: requestUpdateOne,
    updateMany: requestUpdateMany,
  };
  const employeeFindOne = vi.fn().mockReturnValue(query({
    id: 'employee-001',
    employeeNo: 'E001',
    displayName: '张三',
    status: 'active',
    departmentIds: ['department-001'],
  }));
  const versionFind = vi.fn().mockReturnValue(query([{
    aggregateId: 'department-001', externalId: 'external-department-001',
  }]));
  const protect = vi.fn().mockResolvedValue({
    payloadKeyId: 'key-active-001',
    inputDigest: 'a'.repeat(43),
    payloadIv: 'b'.repeat(16),
    payloadCiphertext: 'ciphertext',
    payloadAuthTag: 'c'.repeat(22),
  });
  const matchesDigest = vi.fn().mockResolvedValue(true);
  const unprotect = vi.fn().mockResolvedValue({ email: 'person@example.com' });
  const erase = vi.fn();
  const resolveEmployeeIdentity = vi.fn().mockResolvedValue(null);
  const ensureProvisionedEmployee = vi.fn().mockResolvedValue(undefined);
  const findBoundByEmployee = vi.fn().mockResolvedValue(null);
  const bindProvisioned = vi.fn().mockResolvedValue(undefined);
  const resolveExternalTenantId = vi.fn().mockResolvedValue('external-tenant-001');
  const provisionEmployee = vi.fn().mockImplementation(
    (command: { readonly externalUserId: string }) => Promise.resolve({
      externalUserId: command.externalUserId,
      unionId: 'union-001',
      requestId: 'platform-request-001',
    }),
  );
  const dingtalk = { channel: 'dingtalk' as const, provisionEmployee };
  const feishu = { channel: 'feishu' as const, provisionEmployee };
  const recordSystem = vi.fn().mockResolvedValue(undefined);
  const ensureAttendanceMapping = vi.fn().mockResolvedValue(undefined);
  const withTransaction = vi.fn(async (handler: () => Promise<void>) => handler());
  const endSession = vi.fn().mockResolvedValue(undefined);
  const startSession = vi.fn().mockResolvedValue({ withTransaction, endSession });
  const service = new OrgEmployeeProvisioningService(
    { startSession } as unknown as Connection,
    requests as unknown as Model<OrgEmployeeProvisioningRequestDocument>,
    { findOne: employeeFindOne } as unknown as Model<OrgEmployeeDocument>,
    { find: versionFind } as unknown as Model<OrgExternalVersionStateDocument>,
    context,
    { protect, matchesDigest, unprotect, erase } as unknown as OrgProvisioningCryptoService,
    {
      resolveEmployeeIdentity,
      ensureProvisionedEmployee,
    } as unknown as AccessProfileRepository,
    { findBoundByEmployee, bindProvisioned } as unknown as ExternalIdentityRepository,
    { resolveExternalTenantId } as unknown as OrgPlatformCredentialService,
    new OrgPushAdapterRegistry(dingtalk as never, feishu as never),
    { ensure: ensureAttendanceMapping } as unknown as AttendanceProviderMappingRepository,
    { recordSystem } as unknown as AuditService,
  );
  return {
    context,
    service,
    requests,
    requestFindOne,
    requestFindOneAndUpdate,
    requestCreate,
    requestUpdateOne,
    requestUpdateMany,
    employeeFindOne,
    versionFind,
    protect,
    matchesDigest,
    unprotect,
    erase,
    resolveEmployeeIdentity,
    ensureProvisionedEmployee,
    findBoundByEmployee,
    bindProvisioned,
    resolveExternalTenantId,
    provisionEmployee,
    ensureAttendanceMapping,
    recordSystem,
    withTransaction,
    endSession,
    startSession,
  };
}

function requestUpdateSet(
  store: ReturnType<typeof assemble>,
  index = 0,
): Readonly<Record<string, unknown>> {
  const calls = store.requestUpdateOne.mock.calls as unknown as readonly (readonly [
    unknown,
    { readonly $set: Readonly<Record<string, unknown>> },
  ])[];
  const update = calls[index]?.[1];
  if (update === undefined) throw new Error('预期请求状态更新');
  return update.$set;
}

describe('OrgEmployeeProvisioningService', () => {
  it('提交时只持久密文与 HMAC 摘要，响应不含联系方式', async () => {
    const store = assemble();
    const result = await store.context.run(trusted, () => store.service.submit(
      payload,
      'idempotency-key-001',
    ));
    expect(result).toMatchObject({ status: 'pending' });
    expect(result.requestId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const persisted = store.requestCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persisted).toMatchObject({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      requestedByActorId: 'operator-001',
      inputDigest: 'a'.repeat(43),
      payloadCiphertext: 'ciphertext',
    });
    expect(JSON.stringify(persisted)).not.toContain('person@example.com');
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(store.protect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', employeeId: 'employee-001' }),
      payload.contact,
    );
  });

  it('同操作人、同员工、同密钥摘要重放返回原请求', async () => {
    const store = assemble();
    store.requestFindOne.mockReturnValue(query({
      requestId: '01K00000000000000000000000',
      employeeId: 'employee-001',
      requestedByActorId: 'operator-001',
      inputDigest: 'a'.repeat(43),
      payloadKeyId: 'key-active-001',
      status: 'pending',
      sensitiveExpiresAt: new Date('2026-07-21T12:00:00.000Z'),
    }));
    const result = await store.context.run(trusted, () => store.service.submit(
      payload,
      'idempotency-key-001',
    ));
    expect(result.requestId).toBe('01K00000000000000000000000');
    expect(store.matchesDigest).toHaveBeenCalled();
    expect(store.requestCreate).not.toHaveBeenCalled();
  });

  it('空联系方式与钉钉缺少手机号在触达密钥前被拒绝', async () => {
    const store = assemble();
    const missingContact = await store.context.run(trusted, () => store.service.submit(
      { employeeId: 'employee-001', channel: 'feishu', contact: {} },
      'idempotency-key-001',
    )).catch((error: unknown) => error);
    expect(missingContact).toBeInstanceOf(BadRequestException);
    if (!(missingContact instanceof BadRequestException)) throw new Error('预期参数错误');
    expect(missingContact.getResponse()).toMatchObject({ code: 'ORG_PROVISIONING_CONTACT_REQUIRED' });
    const missingMobile = await store.context.run(trusted, () => store.service.submit(
      { employeeId: 'employee-001', channel: 'dingtalk', contact: { email: 'a@example.com' } },
      'idempotency-key-002',
    )).catch((error: unknown) => error);
    expect(missingMobile).toBeInstanceOf(BadRequestException);
    if (!(missingMobile instanceof BadRequestException)) throw new Error('预期参数错误');
    expect(missingMobile.getResponse()).toMatchObject({ code: 'DINGTALK_PROVISIONING_MOBILE_REQUIRED' });
    expect(store.protect).not.toHaveBeenCalled();
  });

  it('手机号国家码与号码合计超过 E.164 上限时在加密前拒绝', async () => {
    const store = assemble();
    const error = await store.context.run(trusted, () => store.service.submit(
      {
        employeeId: 'employee-001',
        channel: 'feishu',
        contact: {
          mobile: { countryCode: '+1234', subscriberNumber: '123456789012' },
        },
      },
      'idempotency-key-001',
    )).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof BadRequestException)) throw new Error('预期参数错误');
    expect(error.getResponse()).toMatchObject({ code: 'ORG_PROVISIONING_MOBILE_INVALID' });
    expect(store.protect).not.toHaveBeenCalled();
  });

  it('R3 开户即使持有 scope 也拒绝 MCP 服务主体', async () => {
    const store = assemble();
    const serviceContext = {
      ...trusted,
      actor: { ...trusted.actor, actorType: 'mcp_client' as const },
    };
    const error = await store.context.run(serviceContext, () => store.service.submit(
      payload,
      'idempotency-key-001',
    )).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ForbiddenException);
    if (!(error instanceof ForbiddenException)) throw new Error('预期权限错误');
    expect(error.getResponse()).toMatchObject({ code: 'ORG_PROVISIONING_HUMAN_REQUIRED' });
    expect(store.requestFindOne).not.toHaveBeenCalled();
    expect(store.protect).not.toHaveBeenCalled();
  });

  it('Worker 成功时回读部门映射、调用平台并事务绑定身份后擦除密文', async () => {
    const store = assemble();
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));

    await expect(store.service.processBatch('worker-001', 10)).resolves.toBe(1);
    expect(store.versionFind).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', channel: 'feishu' }),
      { aggregateId: 1, externalId: 1, _id: 0 },
    );
    expect(store.provisionEmployee).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      employeeNo: 'E001',
      departmentExternalIds: ['external-department-001'],
      contact: { email: 'person@example.com' },
    }));
    expect(store.withTransaction).toHaveBeenCalledOnce();
    expect(store.ensureProvisionedEmployee).toHaveBeenCalledWith(
      'tenant-001', 'employee-001', 'employee-001', ['department-001'], expect.anything(),
    );
    const boundProfile = store.bindProvisioned.mock.calls[0]?.[1] as unknown as {
      readonly externalUserId: string;
      readonly unionId: string;
    };
    expect(boundProfile.externalUserId).toMatch(/^gq_[A-Za-z0-9_-]{32}$/);
    expect(boundProfile.unionId).toBe('union-001');
    expect(store.ensureAttendanceMapping).toHaveBeenCalledWith(
      'tenant-001', 'feishu', 'employee-001', expect.stringMatching(/^gq_[A-Za-z0-9_-]{32}$/),
      expect.anything(),
    );
    const completed = store.requestUpdateOne.mock.calls[0]?.[1] as {
      readonly $set: Record<string, unknown>;
    };
    expect(completed.$set).toMatchObject({
      status: 'succeeded',
      payloadIv: null,
      payloadCiphertext: null,
      payloadAuthTag: null,
    });
    expect(store.erase).toHaveBeenCalledWith({ email: 'person@example.com' });
    expect(store.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ riskLevel: 'R3', outcome: 'success' }),
    );
    expect(store.endSession).toHaveBeenCalledOnce();
  });

  it('可重试失败保留密文并退避，不记录错误正文', async () => {
    const store = assemble();
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    store.provisionEmployee.mockRejectedValueOnce(
      new OrgPushError('FEISHU_TEMPORARY_FAILURE', 'retryable', '含敏感正文的上游错误'),
    );

    await expect(store.service.processBatch('worker-001', 10)).resolves.toBe(0);
    const failed = store.requestUpdateOne.mock.calls[0]?.[1] as {
      readonly $set: Record<string, unknown>;
    };
    expect(failed.$set).toMatchObject({
      status: 'pending', attempts: 1, lastErrorCode: 'FEISHU_TEMPORARY_FAILURE',
    });
    expect(failed.$set).not.toHaveProperty('payloadCiphertext');
    expect(JSON.stringify(store.requestUpdateOne.mock.calls)).not.toContain('含敏感正文');
    expect(store.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ riskLevel: 'R3', outcome: 'failure' }),
    );
  });

  it('事务提交后的审计故障向上抛出且不得把成功请求改写为失败', async () => {
    const store = assemble();
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    store.recordSystem.mockRejectedValueOnce(new Error('审计存储不可用'));

    await expect(store.service.processBatch('worker-001', 10))
      .rejects.toThrow('开户已提交但审计不可用');
    expect(store.requestUpdateOne).toHaveBeenCalledOnce();
    expect(store.requestUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'succeeded' },
    });
  });

  it('拒绝缺失、过短或白名单外的幂等键', async () => {
    for (const idempotencyKey of ['', 'short', 'invalid/key']) {
      const store = assemble();
      const error = await store.context.run(trusted, () => store.service.submit(
        payload,
        idempotencyKey,
      )).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(BadRequestException);
      if (!(error instanceof BadRequestException)) throw new Error('预期参数错误');
      expect(error.getResponse()).toMatchObject({
        code: 'ORG_PROVISIONING_IDEMPOTENCY_KEY_INVALID',
      });
      expect(store.requestFindOne).not.toHaveBeenCalled();
    }
  });

  it('员工不存在、状态不允许、已绑定或身份停用时均在加密前失败关闭', async () => {
    const missing = assemble();
    missing.employeeFindOne.mockReturnValue(query(null));
    await expect(missing.context.run(trusted, () => missing.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toBeInstanceOf(NotFoundException);

    const inactive = assemble();
    inactive.employeeFindOne.mockReturnValue(query({ id: 'employee-001', status: 'terminated' }));
    await expect(inactive.context.run(trusted, () => inactive.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toBeInstanceOf(ConflictException);

    const bound = assemble();
    bound.findBoundByEmployee.mockResolvedValue({
      actorId: 'actor-001',
      externalUserId: 'external-user-001',
      unionId: 'union-001',
    });
    const boundError = await bound.context.run(trusted, () => bound.service.submit(
      payload,
      'idempotency-key-001',
    )).catch((reason: unknown) => reason);
    expect(boundError).toBeInstanceOf(ConflictException);
    if (!(boundError instanceof ConflictException)) throw new Error('预期冲突错误');
    expect(boundError.getResponse()).toMatchObject({ code: 'ORG_PROVISIONING_ALREADY_BOUND' });

    const disabled = assemble();
    disabled.resolveEmployeeIdentity.mockResolvedValue({
      actorId: 'actor-001',
      employeeId: 'employee-001',
      status: 'disabled',
      departmentIds: ['department-001'],
    });
    const disabledError = await disabled.context.run(trusted, () => disabled.service.submit(
      payload,
      'idempotency-key-001',
    )).catch((reason: unknown) => reason);
    expect(disabledError).toBeInstanceOf(ConflictException);
    if (!(disabledError instanceof ConflictException)) throw new Error('预期冲突错误');
    expect(disabledError.getResponse()).toMatchObject({ code: 'ORG_PROVISIONING_IDENTITY_DISABLED' });

    expect(missing.protect).not.toHaveBeenCalled();
    expect(inactive.protect).not.toHaveBeenCalled();
    expect(bound.protect).not.toHaveBeenCalled();
    expect(disabled.protect).not.toHaveBeenCalled();
  });

  it('幂等重放严格绑定原员工、操作人和联系方式摘要', async () => {
    const existing = {
      requestId: '01K00000000000000000000000',
      employeeId: 'employee-001',
      requestedByActorId: 'operator-001',
      inputDigest: 'a'.repeat(43),
      payloadKeyId: 'key-active-001',
      status: 'pending',
      sensitiveExpiresAt: new Date('2026-07-21T12:00:00.000Z'),
    };
    const employeeConflict = assemble();
    employeeConflict.requestFindOne.mockReturnValue(query({
      ...existing,
      employeeId: 'employee-other',
    }));
    const conflictError = await employeeConflict.context.run(
      trusted,
      () => employeeConflict.service.submit(
      payload,
      'idempotency-key-001',
      ),
    ).catch((reason: unknown) => reason);
    expect(conflictError).toBeInstanceOf(ConflictException);
    if (!(conflictError instanceof ConflictException)) throw new Error('预期冲突错误');
    expect(conflictError.getResponse()).toMatchObject({
      code: 'ORG_PROVISIONING_IDEMPOTENCY_KEY_REUSED',
    });
    expect(employeeConflict.matchesDigest).not.toHaveBeenCalled();

    const actorConflict = assemble();
    actorConflict.requestFindOne.mockReturnValue(query({
      ...existing,
      requestedByActorId: 'operator-other',
    }));
    await expect(actorConflict.context.run(trusted, () => actorConflict.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toBeInstanceOf(ConflictException);

    const digestConflict = assemble();
    digestConflict.requestFindOne.mockReturnValue(query(existing));
    digestConflict.matchesDigest.mockResolvedValue(false);
    await expect(digestConflict.context.run(trusted, () => digestConflict.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toBeInstanceOf(ConflictException);
  });

  it('并发唯一键冲突只在回读同一请求后重放，其他写入错误保持原样', async () => {
    const existing = {
      requestId: '01K00000000000000000000000',
      employeeId: 'employee-001',
      requestedByActorId: 'operator-001',
      inputDigest: 'a'.repeat(43),
      payloadKeyId: 'key-active-001',
      status: 'pending',
      sensitiveExpiresAt: new Date('2026-07-21T12:00:00.000Z'),
    };
    const concurrent = assemble();
    concurrent.requestFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(existing));
    concurrent.requestCreate.mockRejectedValue({ code: 11_000 });
    await expect(concurrent.context.run(trusted, () => concurrent.service.submit(
      payload,
      'idempotency-key-001',
    ))).resolves.toMatchObject({ requestId: existing.requestId });

    const missingConcurrent = assemble();
    missingConcurrent.requestCreate.mockRejectedValue({ code: 11_000 });
    await expect(missingConcurrent.context.run(trusted, () => missingConcurrent.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toMatchObject({ code: 11_000 });

    const storageFailure = assemble();
    storageFailure.requestCreate.mockRejectedValue(new Error('数据库不可用'));
    await expect(storageFailure.context.run(trusted, () => storageFailure.service.submit(
      payload,
      'idempotency-key-001',
    ))).rejects.toThrow('数据库不可用');
  });

  it('状态查询校验 ULID、租户隔离、缺失记录和最小响应', async () => {
    const invalid = assemble();
    await expect(invalid.context.run(trusted, () => invalid.service.getStatus('invalid')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(invalid.requestFindOne).not.toHaveBeenCalled();

    const missing = assemble();
    await expect(missing.context.run(trusted, () => missing.service.getStatus(
      '01K00000000000000000000000',
    ))).rejects.toBeInstanceOf(NotFoundException);

    const found = assemble();
    found.requestFindOne.mockReturnValue(query({
      requestId: '01K00000000000000000000000',
      status: 'manual_review',
      attempts: 3,
      lastErrorCode: 'ORG_PROVISIONING_FAILURE',
      sensitiveExpiresAt: new Date('2026-07-21T12:00:00.000Z'),
    }));
    await expect(found.context.run(trusted, () => found.service.getStatus(
      '01K00000000000000000000000',
    ))).resolves.toEqual({
      requestId: '01K00000000000000000000000',
      status: 'manual_review',
      attempts: 3,
      lastErrorCode: 'ORG_PROVISIONING_FAILURE',
      sensitiveExpiresAt: '2026-07-21T12:00:00.000Z',
    });
    expect(found.requestFindOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', requestId: '01K00000000000000000000000' },
      expect.anything(),
    );
  });

  it('批处理先擦除到期密文并拒绝非法 Worker 参数', async () => {
    const store = assemble();
    await expect(store.service.processBatch('worker-001', 2)).resolves.toBe(0);
    const expirationCall = store.requestUpdateMany.mock.calls[0] as unknown as readonly [
      Readonly<Record<string, unknown>>,
      { readonly $set: Readonly<Record<string, unknown>> },
    ];
    expect(expirationCall[0]).toMatchObject({
      status: { $in: ['pending', 'processing'] },
      payloadCiphertext: { $ne: null },
    });
    expect(expirationCall[1].$set).toMatchObject({
      status: 'expired',
      payloadCiphertext: null,
    });
    await expect(store.service.processBatch('bad/worker', 1)).rejects.toThrow(
      '开户 Worker 参数非法',
    );
    await expect(store.service.processBatch('worker-001', 0)).rejects.toThrow(
      '开户 Worker 参数非法',
    );
    await expect(store.service.processBatch('worker-001', 26)).rejects.toThrow(
      '开户 Worker 参数非法',
    );
    await expect(store.service.processBatch('worker-001', 1.5)).rejects.toThrow(
      '开户 Worker 参数非法',
    );
  });

  it('损坏的任务记录在任何身份、密钥或平台调用前进入人工复核', async () => {
    const invalidClaims = [
      { tenantId: '$ne' },
      { requestId: 'invalid' },
      { employeeId: '$bad' },
      { channel: 'op' },
      { idempotencyKey: 'short' },
      { payloadKeyId: '$bad' },
      { attempts: -1 },
      { attempts: 6 },
      { attempts: 1.5 },
      { sensitiveExpiresAt: new Date('invalid') },
    ];
    for (const override of invalidClaims) {
      const store = assemble();
      store.requestFindOneAndUpdate
        .mockReturnValueOnce(query(claimedRequest(override)))
        .mockReturnValue(query(null));
      await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
      expect(store.provisionEmployee).not.toHaveBeenCalled();
      const update = requestUpdateSet(store);
      expect(['manual_review', 'expired']).toContain(update.status);
      expect(update).toMatchObject({
        lastErrorCode: 'ORG_PROVISIONING_RECORD_INVALID',
        payloadCiphertext: null,
      });
    }
  });

  it('处理期间刚过期的私密资料进入 expired 且不触达平台', async () => {
    const store = assemble();
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest({
        sensitiveExpiresAt: new Date(Date.now() - 1),
      })))
      .mockReturnValue(query(null));
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(store)).toMatchObject({
      status: 'expired',
      lastErrorCode: 'ORG_PROVISIONING_PAYLOAD_EXPIRED',
    });
    expect(store.provisionEmployee).not.toHaveBeenCalled();
  });

  it('员工消失、停用或授权主体停用时清除密文并进入人工复核', async () => {
    const cases = [
      {
        configure: (store: ReturnType<typeof assemble>) =>
          store.employeeFindOne.mockReturnValue(query(null)),
        code: 'ORG_PROVISIONING_EMPLOYEE_MISSING',
      },
      {
        configure: (store: ReturnType<typeof assemble>) =>
          store.employeeFindOne.mockReturnValue(query({ status: 'terminated' })),
        code: 'ORG_PROVISIONING_EMPLOYEE_INACTIVE',
      },
      {
        configure: (store: ReturnType<typeof assemble>) =>
          store.resolveEmployeeIdentity.mockResolvedValue({
            actorId: 'actor-001',
            employeeId: 'employee-001',
            status: 'disabled',
            departmentIds: ['department-001'],
          }),
        code: 'ORG_PROVISIONING_IDENTITY_DISABLED',
      },
    ];
    for (const testCase of cases) {
      const store = assemble();
      testCase.configure(store);
      store.requestFindOneAndUpdate
        .mockReturnValueOnce(query(claimedRequest()))
        .mockReturnValue(query(null));
      await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
      expect(requestUpdateSet(store)).toMatchObject({
        status: 'manual_review',
        lastErrorCode: testCase.code,
        payloadCiphertext: null,
      });
      expect(store.provisionEmployee).not.toHaveBeenCalled();
    }
  });

  it('已存在可信平台绑定时不重复外部开户并补齐本地主体与考勤映射', async () => {
    const store = assemble();
    store.resolveEmployeeIdentity.mockResolvedValue({
      actorId: 'actor-001',
      employeeId: 'employee-001',
      status: 'active',
      departmentIds: ['department-001'],
    });
    store.findBoundByEmployee.mockResolvedValue({
      actorId: 'actor-001',
      externalUserId: 'external-user-001',
      unionId: 'union-001',
    });
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));

    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.provisionEmployee).not.toHaveBeenCalled();
    expect(store.bindProvisioned).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        externalUserId: 'external-user-001',
        unionId: 'union-001',
        actorId: 'actor-001',
      }),
      expect.anything(),
    );
  });

  it('部门主数据损坏或平台映射未就绪时失败关闭', async () => {
    const invalidDepartments = assemble();
    invalidDepartments.employeeFindOne.mockReturnValue(query({
      id: 'employee-001',
      employeeNo: 'E001',
      displayName: '张三',
      status: 'active',
      departmentIds: [],
    }));
    invalidDepartments.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(invalidDepartments.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(invalidDepartments)).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'ORG_PROVISIONING_DEPARTMENTS_INVALID',
    });

    const missingMapping = assemble();
    missingMapping.versionFind.mockReturnValue(query([]));
    missingMapping.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(missingMapping.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(missingMapping)).toMatchObject({
      status: 'pending',
      lastErrorCode: 'ORG_PROVISIONING_DEPARTMENT_NOT_READY',
    });
  });

  it('任一密文组件缺失时不得解密或触达平台', async () => {
    for (const field of ['payloadIv', 'payloadCiphertext', 'payloadAuthTag'] as const) {
      const store = assemble();
      store.requestFindOneAndUpdate
        .mockReturnValueOnce(query(claimedRequest({ [field]: null })))
        .mockReturnValue(query(null));
      await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
      expect(store.unprotect).not.toHaveBeenCalled();
      expect(store.provisionEmployee).not.toHaveBeenCalled();
      expect(requestUpdateSet(store)).toMatchObject({
        status: 'manual_review',
        lastErrorCode: 'ORG_PROVISIONING_PAYLOAD_MISSING',
      });
    }
  });

  it('平台回读身份必须绑定 ERP 确定性用户标识并校验所有平台标识', async () => {
    const mismatch = assemble();
    mismatch.provisionEmployee.mockResolvedValue({
      externalUserId: 'attacker-user',
      unionId: 'union-001',
    });
    mismatch.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(mismatch.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(mismatch.bindProvisioned).not.toHaveBeenCalled();
    expect(requestUpdateSet(mismatch)).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'ORG_PROVISIONING_PLATFORM_IDENTITY_CONFLICT',
    });

    const invalidUnion = assemble();
    invalidUnion.provisionEmployee.mockImplementation(
      (command: { readonly externalUserId: string }) => Promise.resolve({
        externalUserId: command.externalUserId,
        unionId: '$bad',
      }),
    );
    invalidUnion.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(invalidUnion.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(invalidUnion)).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'ORG_PROVISIONING_PLATFORM_IDENTITY_INVALID',
    });
  });

  it('非法平台请求标识只丢弃该字段且不影响开户终态', async () => {
    const store = assemble();
    store.provisionEmployee.mockImplementation(
      (command: { readonly externalUserId: string }) => Promise.resolve({
        externalUserId: command.externalUserId,
        unionId: 'union-001',
        requestId: '$bad',
      }),
    );
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(1);
    expect(requestUpdateSet(store)).toMatchObject({
      status: 'succeeded',
      platformRequestId: null,
    });
  });

  it('成功提交后的会话清理故障单独上抛且不得回写失败终态', async () => {
    const store = assemble();
    store.endSession.mockRejectedValue(new Error('会话清理失败'));
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(store.service.processBatch('worker-001', 1))
      .rejects.toThrow('开户已提交但数据库会话清理不可用');
    expect(store.requestUpdateOne).toHaveBeenCalledOnce();
    expect(requestUpdateSet(store)).toMatchObject({ status: 'succeeded' });
    expect(store.recordSystem).not.toHaveBeenCalled();
  });

  it('事务失败时会话清理异常不得覆盖原始事务错误', async () => {
    const store = assemble();
    store.withTransaction.mockRejectedValue(new Error('事务提交失败'));
    store.endSession.mockRejectedValue(new Error('会话清理失败'));
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(store)).toMatchObject({
      status: 'pending',
      lastErrorCode: 'ORG_PROVISIONING_INTERNAL',
    });
  });

  it('失败终态提交后的审计故障单独上抛且不重复更新请求', async () => {
    const store = assemble();
    store.provisionEmployee.mockRejectedValue(
      new OrgPushError('FEISHU_CONFLICT', 'conflict', '冲突'),
    );
    store.recordSystem.mockRejectedValue(new Error('审计不可用'));
    store.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(store.service.processBatch('worker-001', 1))
      .rejects.toThrow('开户失败终态已提交但审计不可用');
    expect(store.requestUpdateOne).toHaveBeenCalledOnce();
    expect(requestUpdateSet(store)).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'FEISHU_CONFLICT',
    });
  });

  it('非规范上游错误码只持久化稳定兜底码，失败租约丢失则立即失败', async () => {
    const safeCode = assemble();
    safeCode.provisionEmployee.mockRejectedValue(
      new OrgPushError('invalid-code', 'business', '失败'),
    );
    safeCode.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(safeCode.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(requestUpdateSet(safeCode)).toMatchObject({
      lastErrorCode: 'ORG_PROVISIONING_FAILURE',
    });

    const leaseLost = assemble();
    leaseLost.provisionEmployee.mockRejectedValue(new Error('未知错误'));
    leaseLost.requestUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    leaseLost.requestFindOneAndUpdate
      .mockReturnValueOnce(query(claimedRequest()))
      .mockReturnValue(query(null));
    await expect(leaseLost.service.processBatch('worker-001', 1))
      .rejects.toThrow('开户失败状态租约已丢失');
    expect(leaseLost.recordSystem).not.toHaveBeenCalled();
  });
});
