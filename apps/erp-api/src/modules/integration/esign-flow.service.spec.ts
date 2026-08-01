import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import { ESignFlowService, hashExternalFlowId } from './esign-flow.service.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function fixture(scopes: readonly string[]) {
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001', source: 'service_identity' }),
    getActorRequired: () => ({ scopes }),
  };
  const offers = { get: vi.fn().mockResolvedValue({ status: 'accepted' }) };
  const crypto = {
    protectExternalId: vi.fn().mockReturnValue({
      externalIdKeyId: 'esign-key-001', externalIdIv: 'A'.repeat(16),
      externalIdCiphertext: 'B'.repeat(32), externalIdAuthTag: 'C'.repeat(22),
    }),
    unprotectExternalId: vi.fn().mockReturnValue('external-flow-sensitive-001'),
  };
  const bindings = { findOne: vi.fn().mockReturnValue(query({ appId: 'app12345' })) };
  const flows = {
    findOne: vi.fn().mockReturnValue(query(null)),
    create: vi.fn().mockImplementation((record: Record<string, unknown>) => Promise.resolve({
      toObject: () => record,
    })),
  };
  const service = new ESignFlowService(
    context as unknown as TenantContextService,
    offers as unknown as RecruitmentOfferService,
    crypto as unknown as ESignWebhookCryptoService,
    bindings as unknown as Model<ESignBindingDocument>,
    flows as unknown as Model<ESignFlowDocument>,
  );
  return { service, offers, crypto, bindings, flows };
}

describe('ESignFlowService', () => {
  it('只对已接受 Offer 登记经租户绑定的加密外部流程', async () => {
    const store = fixture(['erp:integration:esign:create']);
    const result = await store.service.registerForOffer(
      '01K00000000000000000000001', 'external-flow-sensitive-001',
    );
    expect(result).toMatchObject({
      offerId: '01K00000000000000000000001', status: 'awaiting_signature', version: 1,
    });
    expect(store.bindings.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001', provider: 'esign_cn', status: 'active',
    });
    const record = store.flows.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(record)).not.toContain('external-flow-sensitive-001');
    expect(record.externalFlowIdHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.crypto.protectExternalId).toHaveBeenCalledWith(
      'tenant-001', result.id, 'external-flow-sensitive-001',
    );
  });

  it('无受信任 Scope 时在读取 Offer 前失败关闭', async () => {
    const store = fixture([]);
    await expect(store.service.registerForOffer(
      '01K00000000000000000000001', 'external-flow-001',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_TRUSTED_ADAPTER_REQUIRED' } });
    expect(store.offers.get).not.toHaveBeenCalled();
  });

  it('非法外部流程标识在读取 Offer 前失败关闭', async () => {
    const store = fixture(['erp:integration:esign:create']);
    await expect(store.service.registerForOffer(
      '01K00000000000000000000001',
      '../external-flow',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_EXTERNAL_FLOW_ID_INVALID' } });
    expect(store.offers.get).not.toHaveBeenCalled();
  });

  it('只有 accepted Offer 且存在活动租户绑定时可登记', async () => {
    const invalidOffer = fixture(['erp:integration:esign:create']);
    invalidOffer.offers.get.mockResolvedValueOnce({ status: 'sent' });
    await expect(invalidOffer.service.registerForOffer(
      '01K00000000000000000000001', 'external-flow-001',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_OFFER_STATUS_INVALID' } });
    expect(invalidOffer.bindings.findOne).not.toHaveBeenCalled();

    const missingBinding = fixture(['erp:integration:esign:create']);
    missingBinding.bindings.findOne.mockReturnValueOnce(query(null));
    await expect(missingBinding.service.registerForOffer(
      '01K00000000000000000000001', 'external-flow-001',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_BINDING_NOT_FOUND' } });
    expect(missingBinding.flows.findOne).not.toHaveBeenCalled();
  });

  it('同一 Offer 与同一外部流程幂等复用，错位流程拒绝覆盖', async () => {
    const same = fixture(['erp:integration:esign:create']);
    const existing = {
      id: '01K00000000000000000000008',
      offerId: '01K00000000000000000000001',
      status: 'awaiting_signature',
      providerStatus: null,
      reviewRequired: false,
      version: 1,
      externalFlowIdHash: hashExternalFlowId('app12345', 'external-flow-001'),
    };
    same.flows.findOne.mockReturnValueOnce(query(existing));
    await expect(same.service.registerForOffer(
      existing.offerId, 'external-flow-001',
    )).resolves.toMatchObject({ id: existing.id });
    expect(same.flows.create).not.toHaveBeenCalled();

    const conflict = fixture(['erp:integration:esign:create']);
    conflict.flows.findOne.mockReturnValueOnce(query({
      ...existing,
      externalFlowIdHash: 'A'.repeat(43),
    }));
    await expect(conflict.service.registerForOffer(
      existing.offerId, 'external-flow-001',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_OFFER_FLOW_CONFLICT' } });
  });

  it('唯一键竞态只在摘要一致时返回同一流程', async () => {
    const store = fixture(['erp:integration:esign:create']);
    const expectedHash = hashExternalFlowId('app12345', 'external-flow-001');
    const raced = {
      id: '01K00000000000000000000008',
      offerId: '01K00000000000000000000001',
      status: 'awaiting_signature',
      providerStatus: null,
      reviewRequired: false,
      version: 1,
      externalFlowIdHash: expectedHash,
    };
    store.flows.create.mockRejectedValueOnce({ code: 11_000 });
    store.flows.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(raced));
    await expect(store.service.registerForOffer(
      raced.offerId, 'external-flow-001',
    )).resolves.toMatchObject({ id: raced.id });

    const conflict = fixture(['erp:integration:esign:create']);
    conflict.flows.create.mockRejectedValueOnce({ code: 11_000 });
    conflict.flows.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ ...raced, externalFlowIdHash: 'A'.repeat(43) }));
    await expect(conflict.service.registerForOffer(
      raced.offerId, 'external-flow-001',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_OFFER_FLOW_CONFLICT' } });
  });

  it('非唯一键持久化错误原样抛出', async () => {
    const store = fixture(['erp:integration:esign:create']);
    const error = new Error('MONGO_UNAVAILABLE');
    store.flows.create.mockRejectedValueOnce(error);
    await expect(store.service.registerForOffer(
      '01K00000000000000000000001', 'external-flow-001',
    )).rejects.toBe(error);
  });

  it('外部 ID 只在专用可信 Scope 下按租户解密', async () => {
    const store = fixture(['erp:integration:esign:read_external_id']);
    const flow = {
      id: '01K00000000000000000000008',
      tenantId: 'tenant-001',
    };
    store.flows.findOne.mockReturnValueOnce(query(flow));
    await expect(store.service.getExternalIdForAdapter(flow.id))
      .resolves.toBe('external-flow-sensitive-001');
    expect(store.flows.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001', id: flow.id,
    });
    expect(store.crypto.unprotectExternalId).toHaveBeenCalledWith(
      'tenant-001', flow.id, flow,
    );
  });

  it('外部 ID 读取拒绝无 Scope 和缺失流程', async () => {
    const denied = fixture([]);
    await expect(denied.service.getExternalIdForAdapter(
      '01K00000000000000000000008',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_TRUSTED_ADAPTER_REQUIRED' } });
    expect(denied.flows.findOne).not.toHaveBeenCalled();

    const missing = fixture(['erp:integration:esign:read_external_id']);
    await expect(missing.service.getExternalIdForAdapter(
      '01K00000000000000000000008',
    )).rejects.toMatchObject({ response: { code: 'ESIGN_FLOW_NOT_FOUND' } });
  });
});
