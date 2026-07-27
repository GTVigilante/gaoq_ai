import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import type { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
} from './recruitment-channel.adapter.js';
import { RecruitmentChannelStageDeliveryService } from './recruitment-channel-stage-delivery.service.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelStageDeliveryDocument,
  RecruitmentExternalMappingRecord,
  RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E2';
const BINDING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E3';
const MAPPING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E4';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  readonly acknowledgeStage = vi.fn().mockResolvedValue({ receiptId: 'stage-receipt-001' });
  publishPosition() { return Promise.reject(new Error('未用')); }
  closePosition() { return Promise.reject(new Error('未用')); }
  pullApplications() { return Promise.resolve({ deliveries: [], nextCursor: null, hasMore: false }); }
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

function fixture(sourceChannel = 'sandbox_ats') {
  const delivery = {
    eventId: EVENT_ID, tenantId: 'tenant-001', applicationId: APPLICATION_ID,
    applicationVersion: 4, stage: 'offer' as const, status: 'processing', attempts: 1,
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
  const mappingState = { value: {
    id: MAPPING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
    entityType: 'application', erpEntityId: APPLICATION_ID, status: 'active',
    externalIdKeyId: 'key', externalIdIv: 'iv',
    externalIdCiphertext: 'cipher', externalIdAuthTag: 'tag',
  } as RecruitmentExternalMappingRecord | null };
  const mappings = { findOne: vi.fn(() => query(mappingState.value)) };
  const context = new TenantContextService();
  const application = { id: APPLICATION_ID, sourceChannel, version: 5 };
  const recruitment = {
    getApplicationForChannelDelivery: vi.fn().mockImplementation(() => {
      expect(context.getActorRequired()).toMatchObject({
        actorType: 'system_job', scopes: ['erp:recruitment:channel:ack'],
      });
      return Promise.resolve(application);
    }),
  };
  const crypto = {
    unprotect: vi.fn().mockReturnValue('external-application-001'),
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
  };
  const adapter = new Adapter();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const secrets = { resolve: vi.fn().mockReturnValue('credential-not-logged') };
  const service = new RecruitmentChannelStageDeliveryService(
    deliveries as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    mappings as unknown as Model<RecruitmentExternalMappingDocument>,
    context,
    audit as unknown as AuditService,
    recruitment as unknown as RecruitmentApplicationService,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
    secrets,
  );
  return {
    service, delivery, claimState, deliveries, bindingState, bindings, mappingState, mappings,
    application, recruitment, crypto, adapter, audit, secrets,
  };
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

describe('RecruitmentChannelStageDeliveryService', () => {
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

  it('按版本读取窄投影、解密外部申请 ID，并以稳定幂等键回传阶段', async () => {
    const store = fixture();
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    const acknowledgement = store.adapter.acknowledgeStage.mock.calls[0];
    const command = acknowledgement?.[1] as unknown as {
      readonly externalApplicationId: string;
      readonly stage: string;
      readonly idempotencyKey: string;
    } | undefined;
    expect(acknowledgement?.[0]).toBe('credential-not-logged');
    expect(command).toMatchObject({
      externalApplicationId: 'external-application-001', stage: 'offer',
    });
    expect(command?.idempotencyKey).toMatch(/^channel-/u);
    const completed = store.deliveries.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'succeeded',
    );
    expect(completed?.[0]).toMatchObject({ eventId: EVENT_ID, status: 'processing' });
    expect((completed?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'succeeded', receiptFingerprint: FINGERPRINT, failureCode: null,
    });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(
      /external-application-001|credential-not-logged/iu,
    );
  });

  it('本地门户申请只记录 skipped，不误发到任何外部渠道', async () => {
    const store = fixture('portal');
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
    expect(store.bindings.findOne).not.toHaveBeenCalled();
    expect(store.mappings.findOne).not.toHaveBeenCalled();
    const skipped = store.deliveries.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'skipped',
    );
    expect((skipped?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'skipped', receiptFingerprint: null,
    });
  });

  it('手工导入申请同样只记录 skipped', async () => {
    const store = fixture('manual_import');
    await expect(store.service.processBatch(1)).resolves.toBe(1);
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
  });

  it.each(['sandbox_ats', 'portal'])(
    '业务终态提交后审计失败只告警，不得回写失败：%s',
    async (sourceChannel) => {
      const store = fixture(sourceChannel);
      store.audit.record.mockRejectedValueOnce(new Error('AUDIT_STORE_UNAVAILABLE'));
      await expect(store.service.processBatch(1)).resolves.toBe(1);
      expect(store.audit.record).toHaveBeenCalledTimes(1);
      expect(failureState(store)).toBeUndefined();
    },
  );

  it('更早申请版本未完成时阻断阶段回传', async () => {
    const store = fixture();
    store.deliveries.exists.mockResolvedValueOnce({ eventId: 'earlier-event' });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_STAGE_ORDER_BLOCKED');
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
  });

  it('ERP 申请版本落后于投递版本时拒绝外发', async () => {
    const store = fixture();
    store.application.version = 3;
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_STAGE_VERSION_AHEAD');
  });

  it('渠道绑定不存在时失败关闭且不解析密钥', async () => {
    const store = fixture();
    store.bindingState.value = null;
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_BINDING_NOT_FOUND');
    expect(store.secrets.resolve).not.toHaveBeenCalled();
  });

  it('外部申请映射不存在时失败关闭', async () => {
    const store = fixture();
    store.mappingState.value = null;
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_APPLICATION_MAPPING_NOT_FOUND',
    );
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
  });

  it.each([undefined, '<script>'])('拒绝解密后的非法外部申请标识：%s', async (value) => {
    const store = fixture();
    store.crypto.unprotect.mockReturnValue(value);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_MAPPING_CIPHERTEXT_INVALID',
    );
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
  });

  it.each(['', '<script>'])('拒绝渠道返回的非法阶段回执：%s', async (receiptId) => {
    const store = fixture();
    store.adapter.acknowledgeStage.mockResolvedValueOnce({ receiptId });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_ACKNOWLEDGEMENT_INVALID',
    );
  });

  it('回执盲指纹密钥不可用时不提交成功终态', async () => {
    const store = fixture();
    store.crypto.channelFingerprints.mockReturnValueOnce([]);
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_KEY_INVALID');
  });

  it('成功终态租约丢失时回到失败关闭流程', async () => {
    const store = fixture();
    store.deliveries.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('RECRUITMENT_CHANNEL_STAGE_LEASE_LOST');
  });

  it('失败终态租约丢失时立即抛错且不得伪造失败审计', async () => {
    const store = fixture();
    store.deliveries.exists.mockRejectedValueOnce(new Error('UPSTREAM_TIMEOUT'));
    store.deliveries.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.processBatch(1)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_STAGE_FAILURE_LEASE_LOST',
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

  it('供应商稳定响应错误码优先写入失败状态', async () => {
    const store = fixture();
    store.deliveries.exists.mockRejectedValueOnce({
      response: { code: 'CHANNEL_TEMPORARILY_UNAVAILABLE' },
    });
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe('CHANNEL_TEMPORARILY_UNAVAILABLE');
  });

  it('不稳定异常消息统一归类为通用失败码', async () => {
    const store = fixture();
    store.deliveries.exists.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(store.service.processBatch(1)).resolves.toBe(0);
    expect(failureState(store)?.failureCode).toBe(
      'RECRUITMENT_CHANNEL_STAGE_DELIVERY_FAILED',
    );
  });
});
