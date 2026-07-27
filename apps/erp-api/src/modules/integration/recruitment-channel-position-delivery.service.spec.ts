import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { DepartmentRepository } from '../org/persistence/org.repositories.js';
import type { RecruitmentManagementService } from '../recruitment/application/recruitment-management.service.js';
import type { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
  type RecruitmentChannelPositionCommand,
} from './recruitment-channel.adapter.js';
import { RecruitmentChannelPositionDeliveryService } from './recruitment-channel-position-delivery.service.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelPositionDeliveryDocument,
  RecruitmentExternalMappingRecord,
  RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';
const BINDING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  readonly publishPosition = vi.fn().mockResolvedValue({
    externalPositionId: 'external-position-001', receiptId: 'publish-receipt-001',
  });
  readonly closePosition = vi.fn().mockResolvedValue({ receiptId: 'close-receipt-001' });
  pullApplications() { return Promise.resolve({ deliveries: [], nextCursor: null, hasMore: false }); }
  acknowledgeStage() { return Promise.resolve({ receiptId: 'ack-001' }); }
}
class Normalizer extends RecruitmentChannelNormalizer {
  readonly channelCode = 'sandbox_ats'; readonly schemaVersion = 'v1';
  normalize() { return Promise.reject(new Error('未用')); }
}
class Verifier extends RecruitmentChannelEvidenceVerifier {
  readonly channelCode = 'sandbox_ats';
  verify() { return Promise.reject(new Error('未用')); }
}

function query<T>(value: T) {
  const chain = { lean: vi.fn(() => chain), exec: vi.fn().mockResolvedValue(value) };
  return chain;
}

function fixture(positionVersion = 2) {
  const delivery = {
    eventId: EVENT_ID, tenantId: 'tenant-001', bindingId: BINDING_ID,
    channelCode: 'sandbox_ats', positionId: POSITION_ID, positionVersion: 2,
    action: 'publish', targetStatus: 'open', status: 'processing', attempts: 1,
  };
  const claimState = { value: delivery as typeof delivery | null };
  const deliveries = {
    findOneAndUpdate: vi.fn(() => {
      const claimed = claimState.value;
      claimState.value = null;
      return query(claimed);
    }),
    exists: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const bindingState = { value: {
    id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats', status: 'active',
    credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX',
  } as Record<string, unknown> | null };
  const bindings = { findOne: vi.fn(() => query(bindingState.value)) };
  const mappingState = { value: null as RecruitmentExternalMappingRecord | null };
  const mappings = {
    findOne: vi.fn(() => query(mappingState.value)), create: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const position = {
    id: POSITION_ID, title: '小红书经纪人', departmentId: 'department-001',
    location: '上海', headcount: 2, status: positionVersion === 2 ? 'open' : 'closed',
    version: positionVersion,
  };
  const management = { getPosition: vi.fn().mockImplementation(() => Promise.resolve(position)) };
  const departmentState = { value: {
    id: 'department-001', code: 'TALENT', status: 'active',
  } as Record<string, unknown> | null };
  const departments = {
    findById: vi.fn().mockImplementation(() => Promise.resolve(departmentState.value)),
  };
  const crypto = {
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
    protect: vi.fn().mockReturnValue({ keyId: 'key', iv: 'iv', ciphertext: 'cipher', authTag: 'tag' }),
    unprotect: vi.fn(),
  };
  const adapter = new Adapter();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const secrets = { resolve: vi.fn().mockReturnValue('credential-not-logged') };
  const service = new RecruitmentChannelPositionDeliveryService(
    deliveries as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    mappings as unknown as Model<RecruitmentExternalMappingDocument>,
    new TenantContextService(), audit as unknown as AuditService,
    management as unknown as RecruitmentManagementService,
    departments as unknown as DepartmentRepository,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
    secrets,
  );
  return {
    service, delivery, claimState, deliveries, bindingState, bindings, mappingState, mappings,
    position, management, departmentState, departments, crypto, adapter, audit, secrets,
  };
}

function positionMapping(
  overrides: Partial<RecruitmentExternalMappingRecord> = {},
): RecruitmentExternalMappingRecord {
  return {
    id: 'mapping-001', tenantId: 'tenant-001', channelCode: 'sandbox_ats',
    entityType: 'position', erpEntityId: POSITION_ID,
    externalIdBlindIndexes: [FINGERPRINT],
    externalIdKeyId: 'key', externalIdIv: 'iv',
    externalIdCiphertext: 'cipher', externalIdAuthTag: 'tag',
    status: 'active',
    ...overrides,
  } as RecruitmentExternalMappingRecord;
}

function failureState(store: ReturnType<typeof fixture>) {
  const call = store.deliveries.updateOne.mock.calls.find(
    (candidate) => {
      const status = (candidate[1] as { $set?: { status?: string } }).$set?.status;
      return status === 'pending' || status === 'dead';
    },
  );
  return (call?.[1] as { $set?: Record<string, unknown> } | undefined)?.$set;
}

function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error('duplicate key'), { code: 11_000 });
}

describe('RecruitmentChannelPositionDeliveryService', () => {
  it.each([0, 101, 1.5])('拒绝非法批量上限 %s', async (limit) => {
    await expect(fixture().service.processBatch(limit)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID',
    );
  });

  it('没有可领取投递时立即返回零', async () => {
    const store = fixture();
    store.claimState.value = null;
    await expect(store.service.processBatch(2)).resolves.toBe(0);
    expect(store.deliveries.exists).not.toHaveBeenCalled();
  });

  it('开放职位使用稳定幂等键发布，外部 ID 加密映射且回执只存盲指纹', async () => {
    const store = fixture();
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    const publishCall = store.adapter.publishPosition.mock.calls[0];
    const command = publishCall?.[1] as RecruitmentChannelPositionCommand | undefined;
    expect(publishCall?.[0]).toBe('credential-not-logged');
    expect(command).toMatchObject({
      tenantId: 'tenant-001', positionId: POSITION_ID, departmentCode: 'TALENT', headcount: 2,
    });
    expect(command?.idempotencyKey).toMatch(/^channel-/);
    const createdMapping = store.mappings.create.mock.calls[0]?.[0] as
      Record<string, unknown> | undefined;
    expect(createdMapping).toMatchObject({
      entityType: 'position', erpEntityId: POSITION_ID,
      externalIdBlindIndexes: [FINGERPRINT], externalIdCiphertext: 'cipher', status: 'active',
    });
    const completed = store.deliveries.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'succeeded',
    );
    expect(completed?.[0]).toMatchObject({ eventId: EVENT_ID, status: 'processing' });
    expect((completed?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'succeeded', receiptFingerprint: FINGERPRINT,
    });
    expect(completed?.[2]).toEqual({ runValidators: true });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(
      /小红书经纪人|上海|credential-not-logged|external-position-001/iu,
    );
  });

  it('旧版本投递只标记 superseded，不能覆盖新的 ERP 职位状态', async () => {
    const store = fixture(3);
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.adapter.publishPosition).not.toHaveBeenCalled();
    expect(store.mappings.create).not.toHaveBeenCalled();
    const superseded = store.deliveries.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'superseded',
    );
    expect((superseded?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'superseded', receiptFingerprint: null,
    });
    expect(superseded?.[2]).toEqual({ runValidators: true });
  });

  it('业务终态提交后审计失败只告警，不得回写失败或重复发布', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_STORE_UNAVAILABLE'));
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.adapter.publishPosition).toHaveBeenCalledTimes(1);
    expect(store.audit.record).toHaveBeenCalledTimes(1);
    expect(failureState(store)).toBeUndefined();
  });

  it('旧版本终态提交后审计失败仍保持 superseded', async () => {
    const store = fixture(3);
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_STORE_UNAVAILABLE'));
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.audit.record).toHaveBeenCalledTimes(1);
    expect(failureState(store)).toBeUndefined();
  });

  it('渠道前置查询异常按稳定响应错误码重试', async () => {
    const store = fixture();
    const error = { response: { code: 'UPSTREAM_ORDER_BLOCKED' } };
    store.deliveries.exists.mockRejectedValueOnce(error);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)).toMatchObject({
      status: 'pending', failureCode: 'UPSTREAM_ORDER_BLOCKED',
      lockedAt: null, lockedBy: null,
    });
  });

  it('更早版本存在时使用稳定业务错误码失败关闭', async () => {
    const store = fixture();
    store.deliveries.exists.mockResolvedValueOnce({ eventId: 'earlier-event' });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_POSITION_ORDER_BLOCKED');
    const auditInput = store.audit.record.mock.calls[0]?.[0] as {
      outcome?: string; metadata?: { failureCode?: string };
    } | undefined;
    expect(auditInput).toMatchObject({
      outcome: 'failure',
      metadata: { failureCode: 'RECRUITMENT_CHANNEL_POSITION_ORDER_BLOCKED' },
    });
  });

  it.each([
    { version: 1, status: 'open' },
    { version: 2, status: 'closed' },
  ])('ERP 职位版本或目标状态不一致时拒绝外发：$version/$status', async (position) => {
    const store = fixture();
    Object.assign(store.position, position);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_VERSION_MISMATCH',
    );
    expect(store.adapter.publishPosition).not.toHaveBeenCalled();
  });

  it('渠道绑定不存在时失败关闭且不解析密钥', async () => {
    const store = fixture();
    store.bindingState.value = null;
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    expect(store.secrets.resolve).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'department-001', code: 'TALENT', status: 'disabled' }])(
    '部门不存在或未启用时禁止发布：%j',
    async (department) => {
      const store = fixture();
      store.departmentState.value = department;
      await expect(store.service.processBatch(1)).resolves.toBe(0);
      expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_DEPARTMENT_INVALID');
      expect(store.adapter.publishPosition).not.toHaveBeenCalled();
    },
  );

  it.each([
    { externalPositionId: '', receiptId: 'receipt-001' },
    { externalPositionId: 'external-001', receiptId: '<script>' },
  ])('拒绝渠道返回的非法职位标识或回执：%j', async (result) => {
    const store = fixture();
    store.adapter.publishPosition.mockResolvedValueOnce(result);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_RECEIPT_INVALID',
    );
    expect(store.mappings.create).not.toHaveBeenCalled();
  });

  it('已有职位映射的盲索引一致时只恢复为 active', async () => {
    const store = fixture();
    store.mappingState.value = positionMapping({ status: 'paused' });
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.mappings.create).not.toHaveBeenCalled();
    expect(store.mappings.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: 'mapping-001' },
      { $set: { status: 'active' } },
      { runValidators: true },
    );
  });

  it('已有职位映射与渠道返回标识冲突时禁止覆盖', async () => {
    const store = fixture();
    store.mappingState.value = positionMapping({
      externalIdBlindIndexes: [`blind-key-001.${'B'.repeat(43)}`],
    });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT',
    );
    expect(store.mappings.updateOne).not.toHaveBeenCalled();
  });

  it('新建映射的非唯一键异常原样归类为通用失败', async () => {
    const store = fixture();
    store.mappings.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_DELIVERY_FAILED',
    );
  });

  it('唯一键竞态后读取不到同一映射时拒绝覆盖', async () => {
    const store = fixture();
    store.mappings.create.mockRejectedValueOnce(duplicateKeyError());
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT',
    );
  });

  it('唯一键竞态后同一盲索引映射存在时恢复 active', async () => {
    const store = fixture();
    store.mappings.create.mockImplementationOnce(() => {
      store.mappingState.value = positionMapping({ status: 'paused' });
      return Promise.reject(duplicateKeyError());
    });
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.mappings.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: 'mapping-001' },
      { $set: { status: 'active' } },
      { runValidators: true },
    );
  });

  it('映射状态更新未命中时报告映射丢失', async () => {
    const store = fixture();
    store.mappingState.value = positionMapping();
    store.mappings.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_MAPPING_LOST',
    );
  });

  it('未发布过的职位下架不调用渠道，使用合成回执完成幂等终态', async () => {
    const store = fixture();
    Object.assign(store.delivery, { action: 'close', targetStatus: 'closed' });
    Object.assign(store.position, { status: 'closed' });
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.adapter.closePosition).not.toHaveBeenCalled();
    expect(store.crypto.channelFingerprints).toHaveBeenCalledWith(
      'tenant-001', 'event', 'sandbox_ats', `not-published:${EVENT_ID}`,
    );
  });

  it.each([
    { targetStatus: 'paused', mappingStatus: 'paused' },
    { targetStatus: 'closed', mappingStatus: 'closed' },
  ])('已有映射按 $targetStatus 下架并同步映射状态', async ({
    targetStatus, mappingStatus,
  }) => {
    const store = fixture();
    Object.assign(store.delivery, { action: 'close', targetStatus });
    Object.assign(store.position, { status: targetStatus });
    store.mappingState.value = positionMapping();
    store.crypto.unprotect.mockReturnValue('external-position-001');
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    const closeCall = store.adapter.closePosition.mock.calls[0];
    const closeInput = closeCall?.[1] as {
      externalPositionId?: string; idempotencyKey?: string;
    } | undefined;
    expect(closeCall?.[0]).toBe('credential-not-logged');
    expect(closeInput?.externalPositionId).toBe('external-position-001');
    expect(closeInput?.idempotencyKey).toMatch(/^channel-/u);
    expect(store.mappings.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: 'mapping-001' },
      { $set: { status: mappingStatus } },
      { runValidators: true },
    );
  });

  it.each([undefined, '<script>'])('拒绝解密后的非法外部职位标识：%s', async (externalId) => {
    const store = fixture();
    Object.assign(store.delivery, { action: 'close', targetStatus: 'closed' });
    Object.assign(store.position, { status: 'closed' });
    store.mappingState.value = positionMapping();
    store.crypto.unprotect.mockReturnValue(externalId);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_MAPPING_CIPHERTEXT_INVALID',
    );
    expect(store.adapter.closePosition).not.toHaveBeenCalled();
  });

  it('渠道下架回执非法时不更新映射状态', async () => {
    const store = fixture();
    Object.assign(store.delivery, { action: 'close', targetStatus: 'closed' });
    Object.assign(store.position, { status: 'closed' });
    store.mappingState.value = positionMapping();
    store.crypto.unprotect.mockReturnValue('external-position-001');
    store.adapter.closePosition.mockResolvedValueOnce({ receiptId: '' });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_POSITION_RECEIPT_INVALID',
    );
    expect(store.mappings.updateOne).not.toHaveBeenCalled();
  });

  it('回执盲指纹密钥不可用时不提交成功终态', async () => {
    const store = fixture();
    store.crypto.channelFingerprints
      .mockReturnValueOnce([FINGERPRINT])
      .mockReturnValueOnce([]);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_KEY_INVALID');
  });

  it('成功终态租约丢失时回到失败关闭流程', async () => {
    const store = fixture();
    store.deliveries.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_POSITION_LEASE_LOST');
  });

  it('失败终态租约丢失时立即抛错且不得伪造失败审计', async () => {
    const store = fixture();
    store.deliveries.exists.mockRejectedValueOnce(new Error('UPSTREAM_TIMEOUT'));
    store.deliveries.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.processBatch(1)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_POSITION_FAILURE_LEASE_LOST',
    );
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('达到最大尝试次数后进入 dead 且不再退避重试', async () => {
    const store = fixture();
    store.delivery.attempts = 12;
    store.deliveries.exists.mockRejectedValueOnce(new Error('UPSTREAM_TIMEOUT'));
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)).toMatchObject({
      status: 'dead', failureCode: 'UPSTREAM_TIMEOUT',
      lockedAt: null, lockedBy: null,
    });
    expect(failureState(store)?.nextAttemptAt).toBeInstanceOf(Date);
  });
});
