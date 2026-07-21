import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import { ESignFlowService } from './esign-flow.service.js';
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
});
