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
  closePosition() { return Promise.resolve({ receiptId: 'close-receipt-001' }); }
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
  const deliveries = {
    findOneAndUpdate: vi.fn(() => query(delivery)),
    exists: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const bindings = { findOne: vi.fn(() => query({
    id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats', status: 'active',
    credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX',
  })) };
  const mappings = {
    findOne: vi.fn(() => query(null)), create: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const management = { getPosition: vi.fn().mockResolvedValue({
    id: POSITION_ID, title: '小红书经纪人', departmentId: 'department-001',
    location: '上海', headcount: 2, status: positionVersion === 2 ? 'open' : 'closed',
    version: positionVersion,
  }) };
  const departments = { findById: vi.fn().mockResolvedValue({
    id: 'department-001', code: 'TALENT', status: 'active',
  }) };
  const crypto = {
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
    protect: vi.fn().mockReturnValue({ keyId: 'key', iv: 'iv', ciphertext: 'cipher', authTag: 'tag' }),
    unprotect: vi.fn(),
  };
  const adapter = new Adapter();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentChannelPositionDeliveryService(
    deliveries as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    mappings as unknown as Model<RecruitmentExternalMappingDocument>,
    new TenantContextService(), audit as unknown as AuditService,
    management as unknown as RecruitmentManagementService,
    departments as unknown as DepartmentRepository,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
    { resolve: vi.fn().mockReturnValue('credential-not-logged') },
  );
  return { service, deliveries, mappings, management, departments, crypto, adapter, audit };
}

describe('RecruitmentChannelPositionDeliveryService', () => {
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
});
