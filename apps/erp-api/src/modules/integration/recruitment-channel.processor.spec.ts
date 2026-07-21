import type { Job } from 'bullmq';
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
import type { RecruitmentChannelPositionDeliveryService } from './recruitment-channel-position-delivery.service.js';
import type { RecruitmentChannelPositionRelayService } from './recruitment-channel-position-relay.service.js';
import type { RecruitmentChannelStageRelayService } from './recruitment-channel-stage-relay.service.js';
import type { RecruitmentChannelStageDeliveryService } from './recruitment-channel-stage-delivery.service.js';
import type { RecruitmentChannelPullService } from './recruitment-channel-pull.service.js';
import { RecruitmentChannelProcessor } from './recruitment-channel.processor.js';
import {
  RECRUITMENT_CHANNEL_PROCESS_JOB,
  type RecruitmentChannelJobData,
} from './recruitment-channel.queue.js';
import type {
  RecruitmentChannelBindingDocument,
  RecruitmentChannelInboxDocument,
  RecruitmentExternalMappingDocument,
} from './recruitment-channel.schemas.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';
const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C4';
const CONSENT_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C5';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

class Adapter extends RecruitmentChannelAdapter {
  readonly channelCode = 'sandbox_ats';
  readonly acknowledgeStage = vi.fn().mockResolvedValue({ receiptId: 'ack-receipt-001' });
  publishPosition() { return Promise.reject(new Error('未用')); }
  closePosition() { return Promise.reject(new Error('未用')); }
  pullApplications() {
    return Promise.resolve({ deliveries: [], nextCursor: null, hasMore: false });
  }
}

class Normalizer extends RecruitmentChannelNormalizer {
  readonly channelCode = 'sandbox_ats';
  readonly schemaVersion = 'sandbox-v1';
  readonly normalize = vi.fn().mockResolvedValue({
    externalPositionId: 'position-ext-001', externalCandidateId: 'candidate-ext-001',
    externalApplicationId: 'application-ext-001',
    candidate: { name: '渠道候选人', phone: '+8613800138000' },
    consent: {
      version: 'privacy-v1', purpose: '招聘评估与候选人联络',
      expiresAt: '2027-07-21T00:00:00.000Z',
      retentionExpiresAt: '2028-07-21T00:00:00.000Z',
    },
    attachmentReferences: ['resume-file-001'],
  });
}

class Verifier extends RecruitmentChannelEvidenceVerifier {
  readonly channelCode = 'sandbox_ats';
  readonly verify = vi.fn().mockResolvedValue({
    verified: true, consentEvidenceId: CONSENT_EVIDENCE_ID,
    resumeSnapshotId: 'resume-snapshot-001',
  });
}

function query<T>(value: T) {
  const chain = {
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(value),
    limit: vi.fn(() => chain),
  };
  return chain;
}

function fixture(hasEvidenceCheckpoint = false) {
  const context = new TenantContextService();
  const claimed = {
    id: ID, tenantId: 'tenant-001', bindingId: ID, channelCode: 'sandbox_ats',
    payloadKeyId: 'key-001', payloadIv: 'iv', payloadCiphertext: 'ciphertext',
    payloadAuthTag: 'tag', status: 'processing', attempts: 1,
    evidenceVerifiedAt: hasEvidenceCheckpoint ? new Date('2026-07-21T00:01:00.000Z') : null,
    normalizerVersion: hasEvidenceCheckpoint ? 'sandbox-v1' : null,
    consentEvidenceId: hasEvidenceCheckpoint ? CONSENT_EVIDENCE_ID : null,
    resumeSnapshotId: hasEvidenceCheckpoint ? 'resume-snapshot-001' : null,
  };
  const inbox = {
    findOneAndUpdate: vi.fn(() => query(claimed)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const mappings = {
    find: vi.fn(() => query([{ erpEntityId: POSITION_ID }])),
    findOne: vi.fn(() => query(null)),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const bindings = {
    findOne: vi.fn(() => query({
      id: ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats', status: 'active',
      credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX',
    })),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const recruitment = {
    createApplicationFromChannel: vi.fn().mockImplementation(() => {
      expect(context.getActorRequired()).toMatchObject({
        actorType: 'system_job', scopes: ['erp:recruitment:channel:ingest'],
      });
      return Promise.resolve({
        application: {
          id: APPLICATION_ID, candidateId: CANDIDATE_ID, positionId: POSITION_ID,
          stage: 'applied', version: 1, appliedAt: '2026-07-21T00:00:00.000Z', endedAt: null,
        },
      });
    }),
  };
  const crypto = {
    unprotect: vi.fn().mockReturnValue({ raw: '只在 Worker 内存解密' }),
    channelFingerprints: vi.fn().mockReturnValue([FINGERPRINT]),
    protect: vi.fn().mockReturnValue({ keyId: 'key', iv: 'iv', ciphertext: 'cipher', authTag: 'tag' }),
  };
  const adapter = new Adapter();
  const normalizer = new Normalizer();
  const verifier = new Verifier();
  const processor = new RecruitmentChannelProcessor(
    bindings as unknown as Model<RecruitmentChannelBindingDocument>,
    inbox as unknown as Model<RecruitmentChannelInboxDocument>,
    mappings as unknown as Model<RecruitmentExternalMappingDocument>,
    context,
    audit as unknown as AuditService,
    { enqueueDueBindings: vi.fn(), pullBinding: vi.fn() } as unknown as RecruitmentChannelPullService,
    recruitment as unknown as RecruitmentApplicationService,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [normalizer], [verifier]),
    { resolve: vi.fn().mockReturnValue('credential-not-logged') },
    { relayBatch: vi.fn() } as unknown as RecruitmentChannelPositionRelayService,
    { processBatch: vi.fn() } as unknown as RecruitmentChannelPositionDeliveryService,
    { relayBatch: vi.fn() } as unknown as RecruitmentChannelStageRelayService,
    { processBatch: vi.fn() } as unknown as RecruitmentChannelStageDeliveryService,
  );
  const job = {
    id: 'job-001', name: RECRUITMENT_CHANNEL_PROCESS_JOB,
    data: { tenantId: 'tenant-001', inboxId: ID },
  } as Job<RecruitmentChannelJobData>;
  return {
    processor, job, inbox, mappings, audit, recruitment, crypto, adapter, normalizer, verifier,
  };
}

describe('RecruitmentChannelProcessor', () => {
  it('只在标准化与证据均通过后写入申请、外部映射并回执', async () => {
    const store = fixture();
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', inboxId: ID,
    }));
    const checkpoint = store.inbox.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { evidenceVerifiedAt?: Date } }).$set
        ?.evidenceVerifiedAt instanceof Date,
    );
    expect((checkpoint?.[1] as { $set?: unknown }).$set).toMatchObject({
      normalizerVersion: 'sandbox-v1', consentEvidenceId: CONSENT_EVIDENCE_ID,
      resumeSnapshotId: 'resume-snapshot-001',
    });
    const applicationCall = store.recruitment.createApplicationFromChannel.mock.calls[0];
    expect(applicationCall?.[0]).toMatch(/^channel-/);
    expect(applicationCall?.[1]).toMatchObject({
      positionId: POSITION_ID, sourceChannel: 'sandbox_ats', consent: { source: 'channel' },
    });
    expect(applicationCall?.[2]).toEqual({ consentEvidenceId: CONSENT_EVIDENCE_ID });
    expect(store.mappings.create).toHaveBeenCalledTimes(2);
    expect(store.adapter.acknowledgeStage).toHaveBeenCalledWith(
      'credential-not-logged', expect.objectContaining({ stage: 'applied' }),
    );
    const completed = store.inbox.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'completed',
    );
    expect(completed?.[0]).toMatchObject({ tenantId: 'tenant-001', id: ID, status: 'processing' });
    expect((completed?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'completed', applicationId: APPLICATION_ID,
      consentEvidenceId: CONSENT_EVIDENCE_ID, resumeSnapshotId: 'resume-snapshot-001',
      acknowledgementFingerprint: FINGERPRINT,
    });
    expect(completed?.[2]).toEqual({ runValidators: true });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(
      /渠道候选人|13800138000|credential-not-logged|position-ext-001/iu,
    );
  });

  it('标准化输出非法时进入人工复核，不写领域或外部映射', async () => {
    const store = fixture();
    store.normalizer.normalize.mockResolvedValueOnce({
      externalPositionId: 'position-ext-001', candidate: { name: '缺少外部标识' },
    });
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.recruitment.createApplicationFromChannel).not.toHaveBeenCalled();
    expect(store.mappings.create).not.toHaveBeenCalled();
    const review = store.inbox.updateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status === 'manual_review',
    );
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review', failureCode: 'RECRUITMENT_CHANNEL_NORMALIZED_PAYLOAD_INVALID',
    });
    expect(review?.[2]).toEqual({ runValidators: true });
  });

  it('崩溃重试复用 Inbox 证据检查点，不重新生成同意证据', async () => {
    const store = fixture(true);
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.verifier.verify).not.toHaveBeenCalled();
    expect(store.recruitment.createApplicationFromChannel.mock.calls[0]?.[2]).toEqual({
      consentEvidenceId: CONSENT_EVIDENCE_ID,
    });
  });
});
