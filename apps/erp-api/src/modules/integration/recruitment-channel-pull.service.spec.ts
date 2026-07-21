import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentDataCryptoService } from '../recruitment/persistence/recruitment-data-crypto.service.js';
import {
  RecruitmentChannelAdapter,
  RecruitmentChannelEvidenceVerifier,
  RecruitmentChannelNormalizer,
  RecruitmentChannelRegistry,
} from './recruitment-channel.adapter.js';
import { RecruitmentChannelPullService } from './recruitment-channel-pull.service.js';
import type { RecruitmentChannelJobData } from './recruitment-channel.queue.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelInboxDocument,
} from './recruitment-channel.schemas.js';

const BINDING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  readonly pullApplications = vi.fn().mockResolvedValue({
    deliveries: [{
      externalEventId: 'event-external-001', occurredAt: '2026-07-21T00:00:00.000Z',
      payload: { candidate: '原始候选人数据' },
    }],
    nextCursor: 'cursor-next-001', hasMore: false,
  });
  publishPosition() { return Promise.reject(new Error('未用')); }
  closePosition() { return Promise.reject(new Error('未用')); }
  acknowledgeStage() { return Promise.reject(new Error('未用')); }
}

class Normalizer extends RecruitmentChannelNormalizer {
  readonly channelCode = 'sandbox_ats';
  readonly schemaVersion = 'v1';
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

describe('RecruitmentChannelPullService', () => {
  it('补拉后先以盲指纹去重和加密入箱，再更新加密游标', async () => {
    const context = new TenantContextService();
    const binding = {
      id: BINDING_ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
      credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX', status: 'active',
      cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
    };
    const bindings = {
      findOne: vi.fn(() => query(binding)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const inbox = {
      findOne: vi.fn(() => query(null)),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const crypto = {
      channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
      protect: vi.fn().mockImplementation((cryptoContext: { resourceType: string }) =>
        cryptoContext.resourceType === 'channel_cursor'
          ? { keyId: 'cursor-key', iv: 'cursor-iv', ciphertext: 'cursor-cipher', authTag: 'cursor-tag' }
          : { keyId: 'payload-key', iv: 'payload-iv', ciphertext: 'payload-cipher', authTag: 'payload-tag' }),
      unprotect: vi.fn(),
    };
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new Adapter();
    const service = new RecruitmentChannelPullService(
      bindings as unknown as Model<RecruitmentChannelBindingDocument>,
      inbox as unknown as Model<RecruitmentChannelInboxDocument>,
      context,
      crypto as unknown as RecruitmentDataCryptoService,
      new RecruitmentChannelRegistry([adapter], [new Normalizer()], [new Verifier()]),
      { resolve: vi.fn().mockReturnValue('credential-not-logged') },
      queue as unknown as Queue<RecruitmentChannelJobData>,
    );
    const trusted = {
      tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
      actor: {
        actorId: 'system:channel', actorType: 'system_job' as const, tenantId: 'tenant-001',
        roleCodes: [], scopes: ['erp:recruitment:channel:pull'], departmentIds: [], traceId: BINDING_ID,
      },
    };
    await expect(context.run(trusted, () => service.pullBinding(BINDING_ID))).resolves.toBe(1);
    expect(adapter.pullApplications).toHaveBeenCalledWith('credential-not-logged', {
      tenantId: 'tenant-001', cursor: null, limit: 100,
    });
    const inserted = inbox.create.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(inserted).toMatchObject({
      tenantId: 'tenant-001', channelCode: 'sandbox_ats',
      eventBlindIndexes: [FINGERPRINT], payloadCiphertext: 'payload-cipher', status: 'pending',
    });
    expect(JSON.stringify(inserted)).not.toMatch(/event-external-001|原始候选人数据/iu);
    expect(queue.add).toHaveBeenCalledWith(
      'process:recruitment:application',
      expect.objectContaining({ tenantId: 'tenant-001' }),
      expect.objectContaining({ attempts: 12 }),
    );
    const bindingUpdate = bindings.updateOne.mock.calls[0];
    expect(bindingUpdate?.[0]).toMatchObject({ tenantId: 'tenant-001', id: BINDING_ID });
    expect((bindingUpdate?.[1] as { $set?: unknown }).$set).toMatchObject({
      cursorKeyId: 'cursor-key', cursorCiphertext: 'cursor-cipher', lastFailureCode: null,
    });
    expect(bindingUpdate?.[2]).toEqual({ runValidators: true });
  });

  it('同一确定性任务已失败时显式 retry，不能依赖 BullMQ add 静默重放', async () => {
    const failedJob = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(failedJob),
    };
    const service = new RecruitmentChannelPullService(
      {} as Model<RecruitmentChannelBindingDocument>,
      {} as Model<RecruitmentChannelInboxDocument>,
      new TenantContextService(),
      {} as RecruitmentDataCryptoService,
      new RecruitmentChannelRegistry([], [], []),
      { resolve: vi.fn() },
      queue as unknown as Queue<RecruitmentChannelJobData>,
    );
    await (service as unknown as {
      enqueueInbox(tenantId: string, inboxId: string): Promise<void>;
    }).enqueueInbox('tenant-001', BINDING_ID);
    expect(failedJob.retry).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
