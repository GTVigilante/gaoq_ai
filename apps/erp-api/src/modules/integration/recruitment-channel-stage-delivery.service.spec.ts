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
  const deliveries = {
    findOneAndUpdate: vi.fn(() => query(delivery)),
    exists: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const bindings = { findOne: vi.fn(() => query({
    id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats', status: 'active',
    credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX',
  })) };
  const mappings = { findOne: vi.fn(() => query({
    id: MAPPING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
    entityType: 'application', erpEntityId: APPLICATION_ID, status: 'active',
    externalIdKeyId: 'key', externalIdIv: 'iv',
    externalIdCiphertext: 'cipher', externalIdAuthTag: 'tag',
  })) };
  const context = new TenantContextService();
  const recruitment = {
    getApplicationForChannelDelivery: vi.fn().mockImplementation(() => {
      expect(context.getActorRequired()).toMatchObject({
        actorType: 'system_job', scopes: ['erp:recruitment:channel:ack'],
      });
      return Promise.resolve({ id: APPLICATION_ID, sourceChannel, version: 5 });
    }),
  };
  const crypto = {
    unprotect: vi.fn().mockReturnValue('external-application-001'),
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
  };
  const adapter = new Adapter();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentChannelStageDeliveryService(
    deliveries as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    mappings as unknown as Model<RecruitmentExternalMappingDocument>,
    context,
    audit as unknown as AuditService,
    recruitment as unknown as RecruitmentApplicationService,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
    { resolve: vi.fn().mockReturnValue('credential-not-logged') },
  );
  return { service, deliveries, bindings, mappings, recruitment, crypto, adapter, audit };
}

describe('RecruitmentChannelStageDeliveryService', () => {
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
});
