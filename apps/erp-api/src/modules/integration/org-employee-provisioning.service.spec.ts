import type { Connection, Model } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
  const provisionEmployee = vi.fn().mockResolvedValue({
    externalUserId: 'gq_external_user_001',
    unionId: 'union-001',
    requestId: 'platform-request-001',
  });
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
    provisionEmployee,
    ensureAttendanceMapping,
    recordSystem,
    withTransaction,
    endSession,
  };
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
      .mockReturnValueOnce(query({
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
        sensitiveExpiresAt: new Date(Date.now() + 60_000),
      }))
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
    expect(store.bindProvisioned).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ externalUserId: 'gq_external_user_001', unionId: 'union-001' }),
      expect.anything(),
    );
    expect(store.ensureAttendanceMapping).toHaveBeenCalledWith(
      'tenant-001', 'feishu', 'employee-001', 'gq_external_user_001', expect.anything(),
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
      .mockReturnValueOnce(query({
        tenantId: 'tenant-001', requestId: '01K00000000000000000000000',
        employeeId: 'employee-001', channel: 'feishu', idempotencyKey: 'idempotency-key-001',
        payloadKeyId: 'key-active-001', payloadIv: 'b'.repeat(16),
        payloadCiphertext: 'ciphertext', payloadAuthTag: 'c'.repeat(22), attempts: 0,
        sensitiveExpiresAt: new Date(Date.now() + 10 * 60_000),
      }))
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
      .mockReturnValueOnce(query({
        tenantId: 'tenant-001', requestId: '01K00000000000000000000000',
        employeeId: 'employee-001', channel: 'feishu', idempotencyKey: 'idempotency-key-001',
        payloadKeyId: 'key-active-001', payloadIv: 'b'.repeat(16),
        payloadCiphertext: 'ciphertext', payloadAuthTag: 'c'.repeat(22), attempts: 0,
        sensitiveExpiresAt: new Date(Date.now() + 10 * 60_000),
      }))
      .mockReturnValue(query(null));
    store.recordSystem.mockRejectedValueOnce(new Error('审计存储不可用'));

    await expect(store.service.processBatch('worker-001', 10))
      .rejects.toThrow('开户已提交但审计不可用');
    expect(store.requestUpdateOne).toHaveBeenCalledOnce();
    expect(store.requestUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'succeeded' },
    });
  });
});
