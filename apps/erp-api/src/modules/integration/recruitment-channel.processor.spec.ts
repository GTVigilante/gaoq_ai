import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import type { RecruitmentResumeService } from '../recruitment/application/recruitment-resume.service.js';
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
  RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB,
  RECRUITMENT_CHANNEL_PROCESS_JOB,
  RECRUITMENT_CHANNEL_PULL_JOB,
  RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB,
  RECRUITMENT_CHANNEL_RELAY_STAGES_JOB,
  RECRUITMENT_CHANNEL_SCAN_JOB,
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
  const pull = {
    enqueueDueBindings: vi.fn().mockResolvedValue(2),
    pullBinding: vi.fn().mockResolvedValue(3),
  };
  const positionRelay = { relayBatch: vi.fn().mockResolvedValue(4) };
  const positionDeliveries = { processBatch: vi.fn().mockResolvedValue(5) };
  const stageRelay = { relayBatch: vi.fn().mockResolvedValue(6) };
  const stageDeliveries = { processBatch: vi.fn().mockResolvedValue(7) };
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
  const resumes = {
    requestAnalysisFromTrustedEvidence: vi.fn().mockResolvedValue({
      analysis: { id: ID, candidateId: CANDIDATE_ID, status: 'queued' },
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
    pull as unknown as RecruitmentChannelPullService,
    recruitment as unknown as RecruitmentApplicationService,
    resumes as unknown as RecruitmentResumeService,
    crypto as unknown as RecruitmentDataCryptoService,
    new RecruitmentChannelRegistry([adapter], [normalizer], [verifier]),
    { resolve: vi.fn().mockReturnValue('credential-not-logged') },
    positionRelay as unknown as RecruitmentChannelPositionRelayService,
    positionDeliveries as unknown as RecruitmentChannelPositionDeliveryService,
    stageRelay as unknown as RecruitmentChannelStageRelayService,
    stageDeliveries as unknown as RecruitmentChannelStageDeliveryService,
  );
  const job = {
    id: 'job-001', name: RECRUITMENT_CHANNEL_PROCESS_JOB,
    data: { tenantId: 'tenant-001', inboxId: ID },
  } as Job<RecruitmentChannelJobData>;
  return {
    processor, job, claimed, context, inbox, mappings, bindings, audit, pull,
    positionRelay, positionDeliveries, stageRelay, stageDeliveries,
    recruitment, resumes, crypto, adapter, normalizer, verifier,
  };
}

function job(name: string, data: unknown = {}): Job<RecruitmentChannelJobData> {
  return { id: 'job-001', name, data } as Job<RecruitmentChannelJobData>;
}

describe('RecruitmentChannelProcessor', () => {
  it('只在标准化与证据均通过后写入申请、外部映射并回执', async () => {
    const store = fixture();
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', inboxId: ID,
    }));
    expect(store.resumes.requestAnalysisFromTrustedEvidence).toHaveBeenCalledWith(
      expect.stringMatching(/^channel-/u),
      CANDIDATE_ID,
      'resume-snapshot-001',
    );
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

  it.each([
    [RECRUITMENT_CHANNEL_SCAN_JOB, 2, 'enqueueDueBindings'],
    [RECRUITMENT_CHANNEL_RELAY_POSITIONS_JOB, 4, 'positionRelay'],
    [RECRUITMENT_CHANNEL_DELIVER_POSITIONS_JOB, 5, 'positionDeliveries'],
    [RECRUITMENT_CHANNEL_RELAY_STAGES_JOB, 6, 'stageRelay'],
    [RECRUITMENT_CHANNEL_DELIVER_STAGES_JOB, 7, 'stageDeliveries'],
  ] as const)('分派后台任务 %s', async (name, count, dependency) => {
    const store = fixture();
    await expect(store.processor.process(job(name))).resolves.toBe(count);
    if (dependency === 'enqueueDueBindings') {
      expect(store.pull.enqueueDueBindings).toHaveBeenCalledOnce();
    } else if (dependency === 'positionRelay') {
      expect(store.positionRelay.relayBatch).toHaveBeenCalledWith(
        'recruitment-channel-relay', 50,
      );
    } else if (dependency === 'positionDeliveries') {
      expect(store.positionDeliveries.processBatch).toHaveBeenCalledWith(25);
    } else if (dependency === 'stageRelay') {
      expect(store.stageRelay.relayBatch).toHaveBeenCalledWith(
        'recruitment-channel-stage-relay', 50,
      );
    } else {
      expect(store.stageDeliveries.processBatch).toHaveBeenCalledWith(25);
    }
  });

  it('拒绝带额外字段的扫描任务和未知任务', async () => {
    const store = fixture();
    await expect(store.processor.process(
      job(RECRUITMENT_CHANNEL_SCAN_JOB, { tenantId: '越权字段' }),
    )).rejects.toThrow();
    await expect(store.processor.process(job('unknown'))).rejects.toThrow(
      'RECRUITMENT_CHANNEL_JOB_UNKNOWN',
    );
  });

  it('拒绝非法的补拉和处理任务上下文', async () => {
    const store = fixture();
    await expect(store.processor.process(
      job(RECRUITMENT_CHANNEL_PULL_JOB, { tenantId: 'tenant-001' }),
    )).rejects.toThrow();
    await expect(store.processor.process(
      job(RECRUITMENT_CHANNEL_PROCESS_JOB, { tenantId: 'tenant-001', inboxId: 'bad' }),
    )).rejects.toThrow();
  });

  it('在可信拉取上下文执行补拉并记录数量', async () => {
    const store = fixture();
    store.pull.pullBinding.mockImplementationOnce(() => {
      expect(store.context.getActorRequired()).toMatchObject({
        actorType: 'system_job',
        scopes: ['erp:recruitment:channel:pull'],
      });
      return Promise.resolve(3);
    });
    await expect(store.processor.process(job(RECRUITMENT_CHANNEL_PULL_JOB, {
      tenantId: 'tenant-001', bindingId: ID,
    }))).resolves.toBe(3);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.recruitment_channel.pull',
      outcome: 'success',
      metadata: { deliveryCount: 3 },
    }));
  });

  it('补拉业务失败时记录稳定失败码并保留原异常', async () => {
    const store = fixture();
    const error = { response: { code: 'UPSTREAM_RATE_LIMITED' } };
    store.pull.pullBinding.mockRejectedValueOnce(error);
    await expect(store.processor.process(job(RECRUITMENT_CHANNEL_PULL_JOB, {
      tenantId: 'tenant-001', bindingId: ID,
    }))).rejects.toBe(error);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { failureCode: 'UPSTREAM_RATE_LIMITED' },
    }));
  });

  it('补拉业务提交后的成功审计失败不触发失败审计或重拉', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(job(RECRUITMENT_CHANNEL_PULL_JOB, {
      tenantId: 'tenant-001', bindingId: ID,
    }))).resolves.toBe(3);
    expect(store.pull.pullBinding).toHaveBeenCalledOnce();
    expect(store.audit.record).toHaveBeenCalledOnce();
  });

  it('补拉失败终态的审计故障不覆盖原始异常', async () => {
    const store = fixture();
    const upstreamError = new Error('UPSTREAM_TIMEOUT');
    store.pull.pullBinding.mockRejectedValueOnce(upstreamError);
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(job(RECRUITMENT_CHANNEL_PULL_JOB, {
      tenantId: 'tenant-001', bindingId: ID,
    }))).rejects.toBe(upstreamError);
    expect(store.pull.pullBinding).toHaveBeenCalledOnce();
    expect(store.audit.record).toHaveBeenCalledOnce();
  });

  it('没有可领取 Inbox 时幂等返回零', async () => {
    const store = fixture();
    store.inbox.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(store.processor.process(store.job)).resolves.toBe(0);
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('NORMALIZER_TIMEOUT'), 'NORMALIZER_TIMEOUT'],
    [new Error('normalizer timeout'), 'RECRUITMENT_CHANNEL_NORMALIZATION_FAILED'],
    ['上游非结构化异常', 'RECRUITMENT_CHANNEL_NORMALIZATION_FAILED'],
  ])('标准化异常进入人工复核并归一化失败码', async (error, expectedCode) => {
    const store = fixture();
    store.normalizer.normalize.mockRejectedValueOnce(error);
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    const review = store.inbox.updateOne.mock.calls[0];
    expect(review?.[0]).toMatchObject({ status: 'processing' });
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review', failureCode: expectedCode,
    });
    expect(review?.[2]).toEqual({ runValidators: true });
  });

  it('人工复核终态的审计失败不回写为处理失败', async () => {
    const store = fixture();
    store.normalizer.normalize.mockRejectedValueOnce(new Error('NORMALIZER_TIMEOUT'));
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.inbox.updateOne).toHaveBeenCalledTimes(1);
    expect(store.audit.record).toHaveBeenCalledOnce();
  });

  it('人工复核更新丢失租约时转入失败处理', async () => {
    const store = fixture();
    store.normalizer.normalize.mockRejectedValueOnce(new Error('NORMALIZER_TIMEOUT'));
    store.inbox.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_INBOX_LEASE_LOST',
    );
    const failureAudit = store.audit.record.mock.calls[0]?.[0] as {
      outcome?: string;
      metadata?: unknown;
    } | undefined;
    expect(failureAudit?.outcome).toBe('failure');
    expect(failureAudit?.metadata).toMatchObject({
      failureCode: 'RECRUITMENT_CHANNEL_INBOX_LEASE_LOST',
    });
  });

  it('证据检查点的标准化器版本漂移时进入人工复核', async () => {
    const store = fixture(true);
    store.claimed.normalizerVersion = 'sandbox-v0';
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.verifier.verify).not.toHaveBeenCalled();
    expect(store.recruitment.createApplicationFromChannel).not.toHaveBeenCalled();
  });

  it('缺失标准化器版本的旧检查点使用当前版本进入人工复核', async () => {
    const store = fixture(true);
    store.claimed.normalizerVersion = null;
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    const review = store.inbox.updateOne.mock.calls[0];
    expect((review?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'manual_review', normalizerVersion: 'sandbox-v1',
    });
    expect(review?.[2]).toEqual({ runValidators: true });
  });

  it.each([
    [{ consentEvidenceId: null }, '同意证据为空'],
    [{ consentEvidenceId: 'bad' }, '同意证据格式非法'],
    [{ resumeSnapshotId: '含 空格' }, '简历快照格式非法'],
  ])('拒绝非法证据检查点：%s', async (changes) => {
    const store = fixture(true);
    Object.assign(store.claimed, changes);
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_EVIDENCE_CHECKPOINT_INVALID',
    );
    const failure = store.inbox.updateOne.mock.calls[0];
    expect((failure?.[1] as { $set?: unknown }).$set).toMatchObject({ status: 'failed' });
    expect(failure?.[2]).toEqual({ runValidators: true });
  });

  it.each([
    [{ verified: false, consentEvidenceId: CONSENT_EVIDENCE_ID, resumeSnapshotId: null }],
    [{ verified: true, consentEvidenceId: 'bad', resumeSnapshotId: null }],
    [{ verified: true, consentEvidenceId: CONSENT_EVIDENCE_ID, resumeSnapshotId: '含 空格' }],
  ])('拒绝未验证或非法的新证据：%s', async (verified) => {
    const store = fixture();
    store.verifier.verify.mockResolvedValueOnce(verified);
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_EVIDENCE_UNVERIFIED',
    );
  });

  it('证据检查点写入丢失租约时停止领域写入', async () => {
    const store = fixture();
    store.inbox.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_INBOX_LEASE_LOST',
    );
    expect(store.recruitment.createApplicationFromChannel).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'RECRUITMENT_CHANNEL_POSITION_UNBOUND'],
    [[{ erpEntityId: POSITION_ID }, { erpEntityId: ID }],
      'RECRUITMENT_CHANNEL_POSITION_MAPPING_CONFLICT'],
  ])('职位映射必须且只能命中一个：%s', async (positionMappings, expectedCode) => {
    const store = fixture(true);
    store.mappings.find.mockReturnValueOnce(query(positionMappings));
    await expect(store.processor.process(store.job)).rejects.toThrow(expectedCode);
  });

  it('没有简历证据时跳过简历解析并保留邮箱候选人', async () => {
    const store = fixture();
    store.verifier.verify.mockResolvedValueOnce({
      verified: true, consentEvidenceId: CONSENT_EVIDENCE_ID, resumeSnapshotId: null,
    });
    store.normalizer.normalize.mockResolvedValueOnce({
      externalPositionId: 'position-ext-001',
      externalCandidateId: 'candidate-ext-001',
      externalApplicationId: 'application-ext-001',
      candidate: { name: '邮箱候选人', email: 'candidate@example.invalid' },
      consent: {
        version: 'privacy-v1', purpose: '招聘评估与候选人联络',
        expiresAt: '2027-07-21T00:00:00.000Z',
        retentionExpiresAt: '2028-07-21T00:00:00.000Z',
      },
      attachmentReferences: [],
    });
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.resumes.requestAnalysisFromTrustedEvidence).not.toHaveBeenCalled();
    expect(store.recruitment.createApplicationFromChannel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        candidate: { name: '邮箱候选人', email: 'candidate@example.invalid' },
      }),
      expect.anything(),
    );
  });

  it('已存在且归属一致的外部映射不重复创建', async () => {
    const store = fixture(true);
    store.mappings.findOne
      .mockReturnValueOnce(query({ erpEntityId: CANDIDATE_ID }))
      .mockReturnValueOnce(query({ erpEntityId: APPLICATION_ID }));
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    expect(store.mappings.create).not.toHaveBeenCalled();
  });

  it('已存在但归属冲突的外部映射会失败关闭', async () => {
    const store = fixture(true);
    store.mappings.findOne.mockReturnValueOnce(query({ erpEntityId: ID }));
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_MAPPING_CONFLICT',
    );
  });

  it('外部映射创建的非重复键错误原样抛出', async () => {
    const store = fixture(true);
    const error = new Error('MAPPING_STORAGE_FAILED');
    store.mappings.create.mockRejectedValueOnce(error);
    await expect(store.processor.process(store.job)).rejects.toBe(error);
  });

  it('外部映射重复键竞争后归属一致则视为成功', async () => {
    const store = fixture(true);
    store.mappings.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ erpEntityId: CANDIDATE_ID }))
      .mockReturnValueOnce(query(null));
    store.mappings.create
      .mockRejectedValueOnce({ code: 11_000 })
      .mockResolvedValueOnce(undefined);
    await expect(store.processor.process(store.job)).resolves.toBe(1);
  });

  it.each([
    [null],
    [{ erpEntityId: ID }],
  ])('外部映射重复键竞争后归属不明或冲突时失败关闭：%s', async (raced) => {
    const store = fixture(true);
    store.mappings.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(raced));
    store.mappings.create.mockRejectedValueOnce({ code: 11_000 });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_MAPPING_CONFLICT',
    );
  });

  it('渠道绑定失活时不向外部渠道回执', async () => {
    const store = fixture(true);
    store.bindings.findOne.mockReturnValueOnce(query(null));
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_BINDING_NOT_FOUND',
    );
    expect(store.adapter.acknowledgeStage).not.toHaveBeenCalled();
  });

  it('拒绝非法的渠道回执标识', async () => {
    const store = fixture(true);
    store.adapter.acknowledgeStage.mockResolvedValueOnce({ receiptId: '含 空格' });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_ACKNOWLEDGEMENT_INVALID',
    );
  });

  it('回执盲索引密钥不可用时失败关闭', async () => {
    const store = fixture(true);
    store.crypto.channelFingerprints
      .mockReturnValueOnce([FINGERPRINT])
      .mockReturnValueOnce([FINGERPRINT])
      .mockReturnValueOnce([FINGERPRINT])
      .mockReturnValueOnce([]);
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_KEY_INVALID',
    );
  });

  it('完成 Inbox 时丢失租约会转入失败处理', async () => {
    const store = fixture(true);
    store.inbox.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_INBOX_LEASE_LOST',
    );
  });

  it('业务失败后若失败状态也丢失租约则不覆盖新终态', async () => {
    const store = fixture();
    store.crypto.unprotect.mockImplementationOnce(() => {
      throw new Error('PAYLOAD_DECRYPT_FAILED');
    });
    store.inbox.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.processor.process(store.job)).rejects.toThrow(
      'RECRUITMENT_CHANNEL_INBOX_LEASE_LOST',
    );
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('未知业务异常使用稳定兜底码且不泄露错误正文', async () => {
    const store = fixture();
    const error = new Error('上游原始敏感错误');
    store.crypto.unprotect.mockImplementationOnce(() => {
      throw error;
    });
    await expect(store.processor.process(store.job)).rejects.toBe(error);
    const failureAudit = store.audit.record.mock.calls[0]?.[0] as {
      outcome?: string;
      metadata?: unknown;
    } | undefined;
    expect(failureAudit?.outcome).toBe('failure');
    expect(failureAudit?.metadata).toMatchObject({
      failureCode: 'RECRUITMENT_CHANNEL_PROCESSING_FAILED',
    });
  });

  it('上游响应中的非法失败码使用稳定兜底码', async () => {
    const store = fixture();
    const error = Object.assign(new Error('上游响应失败'), {
      response: { code: 'bad code' },
    });
    store.crypto.unprotect.mockImplementationOnce(() => {
      throw error;
    });
    await expect(store.processor.process(store.job)).rejects.toBe(error);
    const failureAudit = store.audit.record.mock.calls[0]?.[0] as {
      metadata?: unknown;
    } | undefined;
    expect(failureAudit?.metadata).toMatchObject({
      failureCode: 'RECRUITMENT_CHANNEL_PROCESSING_FAILED',
    });
  });

  it('业务完成后的成功审计失败不把 Inbox 回写为失败', async () => {
    const store = fixture(true);
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(store.job)).resolves.toBe(1);
    const statuses = store.inbox.updateOne.mock.calls.map(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status,
    );
    expect(statuses).toEqual(['completed']);
    expect(store.audit.record).toHaveBeenCalledOnce();
  });

  it('Inbox 失败终态的审计故障不覆盖原始异常', async () => {
    const store = fixture();
    const processingError = new Error('PAYLOAD_DECRYPT_FAILED');
    store.crypto.unprotect.mockImplementationOnce(() => {
      throw processingError;
    });
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(store.job)).rejects.toBe(processingError);
    const failure = store.inbox.updateOne.mock.calls[0];
    expect((failure?.[1] as { $set?: unknown }).$set).toMatchObject({
      status: 'failed', failureCode: 'PAYLOAD_DECRYPT_FAILED',
    });
    expect(store.audit.record).toHaveBeenCalledOnce();
  });
});
