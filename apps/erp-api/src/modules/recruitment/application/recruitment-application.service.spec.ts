import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  CandidateConsentEvidenceRepository,
  RecruitmentCandidateRepository,
  RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';

const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const CONSENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Z0';
const session = { id: 'session' } as unknown as ClientSession;

const position = {
  id: POSITION_ID, tenantId: 'tenant-001', requisitionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
  title: '小红书经纪人', departmentId: 'department-001', jobLevelId: 'job-level-001',
  location: '上海', headcount: 2, status: 'open' as const, version: 2,
  publishedAt: '2026-07-20T00:00:00.000Z', closedAt: null,
  createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
};

const application = {
  id: APPLICATION_ID, tenantId: 'tenant-001', candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
  positionId: POSITION_ID, consentEvidenceId: CONSENT_ID, sourceChannel: 'portal',
  stage: 'applied' as const, completedInterviewId: null, offerId: null,
  acceptanceEvidenceId: null, onboardingInstanceId: null, employmentId: null,
  version: 1, appliedAt: '2026-07-21T00:00:00.000Z', endedAt: null,
  updatedAt: '2026-07-21T00:00:00.000Z',
};

function fixture(options?: {
  readonly matches?: readonly Record<string, unknown>[];
  readonly actorDepartments?: readonly string[];
  readonly actorScopes?: readonly string[];
  readonly actorType?: 'user' | 'system_job';
}) {
  const execute = vi.fn().mockImplementation(
    async (_operation: string, _key: string, _request: unknown, handler: (value: ClientSession) => Promise<unknown>) =>
      handler(session),
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'actor-001', tenantId: 'tenant-001', actorType: options?.actorType ?? 'user',
      roleCodes: [], scopes: options?.actorScopes ?? [],
      departmentIds: options?.actorDepartments ?? ['department-001'], traceId: 'trace-001',
    },
  };
  const context = {
    getRequired: vi.fn().mockReturnValue(trusted),
    getTenantRequired: vi.fn().mockReturnValue(trusted.tenant),
    getActorRequired: vi.fn().mockReturnValue(trusted.actor),
  };
  const candidates = {
    findByContacts: vi.fn().mockResolvedValue(options?.matches ?? []),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const consents = { appendGranted: vi.fn().mockResolvedValue(undefined) };
  const positions = { findById: vi.fn().mockResolvedValue(position) };
  const applications = {
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(application),
  };
  const stages = { append: vi.fn().mockResolvedValue(undefined) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentApplicationService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    candidates as unknown as RecruitmentCandidateRepository,
    consents as unknown as CandidateConsentEvidenceRepository,
    positions as unknown as RecruitmentPositionRepository,
    applications as unknown as CandidateApplicationRepository,
    stages as unknown as CandidateApplicationStageRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return { service, execute, candidates, consents, positions, applications, stages, outbox };
}

const createInput = {
  positionId: POSITION_ID,
  sourceChannel: 'portal',
  candidate: { name: '张三', phone: '+8613800138000', email: 'candidate@example.com' },
  consent: {
    version: 'privacy-v1', purpose: '招聘评估与候选人联络', source: 'portal' as const,
    expiresAt: '2027-07-21T00:00:00.000Z',
    retentionExpiresAt: '2028-07-21T00:00:00.000Z',
  },
};

describe('RecruitmentApplicationService', () => {
  it('新候选人、授权证据、申请和 Outbox 在同一幂等事务中写入', async () => {
    const store = fixture();
    const result = await store.service.createApplication('create-key-001', createInput);
    expect(store.execute).toHaveBeenCalledWith(
      'recruitment.application.create', 'create-key-001', createInput, expect.any(Function),
    );
    expect(store.candidates.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', phone: '+8613800138000', email: 'candidate@example.com',
    }), session);
    expect(store.consents.appendGranted).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001' }), 'actor-001', session,
    );
    expect(store.applications.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', positionId: POSITION_ID, stage: 'applied',
    }), session);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.application.created', tenantId: 'tenant-001',
    }), session);
    expect(JSON.stringify(result)).not.toMatch(/张三|13800138000|candidate@example/iu);
  });

  it('重复候选人追加新授权并更新主档，不创建第二候选人', async () => {
    const existing = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001', status: 'active' as const,
      name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
      consent: {
        evidenceId: CONSENT_ID, version: 'privacy-v0', purpose: '旧招聘评估', source: 'portal' as const,
        capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
        withdrawnAt: null,
      },
      retentionExpiresAt: '2027-01-01T00:00:00.000Z', version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = fixture({ matches: [existing] });
    await store.service.createApplication('create-key-002', createInput);
    expect(store.candidates.insert).not.toHaveBeenCalled();
    const replaced = store.candidates.replace.mock.calls[0] as unknown as [
      { id: string; version: number; consent: { version: string } }, number, ClientSession,
    ];
    expect(replaced[0]).toMatchObject({ id: existing.id, version: 2 });
    expect(replaced[0].consent.version).toBe('privacy-v1');
    expect(replaced.slice(1)).toEqual([1, session]);
  });

  it('手机与邮箱命中不同候选人时失败关闭且不写申请', async () => {
    const store = fixture({ matches: [{ id: 'candidate-001' }, { id: 'candidate-002' }] });
    await expect(store.service.createApplication('create-key-003', createInput))
      .rejects.toMatchObject({ response: { code: 'CANDIDATE_IDENTITY_CONFLICT' } });
    expect(store.applications.insert).not.toHaveBeenCalled();
  });

  it('普通申请不能借去重流程静默修改已有候选人联系方式', async () => {
    const existing = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001', status: 'active' as const,
      name: '张三', phone: '+8613800138000', email: null,
      consent: {
        evidenceId: CONSENT_ID, version: 'privacy-v0', purpose: '旧招聘评估', source: 'portal' as const,
        capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
        withdrawnAt: null,
      },
      retentionExpiresAt: '2027-01-01T00:00:00.000Z', version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = fixture({ matches: [existing] });
    await expect(store.service.createApplication('create-key-004', createInput))
      .rejects.toMatchObject({
        response: { code: 'CANDIDATE_CONTACT_CHANGE_REVIEW_REQUIRED' },
      });
    expect(store.candidates.replace).not.toHaveBeenCalled();
    expect(store.applications.insert).not.toHaveBeenCalled();
  });

  it('通用入口拒绝自报渠道投递，只有受信任 Worker 窄接口可写入', async () => {
    const channelInput = {
      ...createInput, sourceChannel: 'sandbox_ats',
      consent: { ...createInput.consent, source: 'channel' as const },
    };
    const publicStore = fixture();
    await expect(publicStore.service.createApplication('channel-public-001', channelInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_CHANNEL_WORKER_REQUIRED' } });
    await expect(publicStore.service.createApplicationFromChannel(
      'channel-worker-001', channelInput, { consentEvidenceId: CONSENT_ID },
    ))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_TRUSTED_CHANNEL_REQUIRED' } });
    expect(publicStore.execute).not.toHaveBeenCalled();

    const workerStore = fixture({
      actorType: 'system_job', actorScopes: ['erp:recruitment:channel:ingest'],
    });
    await expect(workerStore.service.createApplicationFromChannel(
      'channel-worker-002', channelInput, { consentEvidenceId: CONSENT_ID },
    )).resolves.toMatchObject({ application: { positionId: POSITION_ID } });
    expect(workerStore.execute).toHaveBeenCalledOnce();
    expect(workerStore.execute.mock.calls[0]?.[2]).toMatchObject({
      trustedConsentEvidenceId: CONSENT_ID,
    });
    expect(workerStore.applications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ consentEvidenceId: CONSENT_ID }), session,
    );
    await expect(workerStore.service.createApplicationFromChannel(
      'channel-worker-003', channelInput, { consentEvidenceId: 'unverified-reference' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_CHANNEL_CONSENT_EVIDENCE_INVALID' },
    });
  });

  it('通用入口拒绝伪造来源渠道和缺少专用证据链的人工导入', async () => {
    const store = fixture();
    await expect(store.service.createApplication('source-spoof-001', {
      ...createInput, sourceChannel: 'sandbox_ats',
    })).rejects.toMatchObject({ response: { code: 'RECRUITMENT_SOURCE_CHANNEL_INVALID' } });
    await expect(store.service.createApplication('manual-import-001', {
      ...createInput, sourceChannel: 'manual_import',
      consent: { ...createInput.consent, source: 'manual_import' as const },
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MANUAL_IMPORT_WORKFLOW_REQUIRED' },
    });
    expect(store.execute).not.toHaveBeenCalled();
  });

  it('阶段推进原子写聚合、阶段日志和 Outbox', async () => {
    const store = fixture();
    const result = await store.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-key-001', { targetStage: 'screening' },
    );
    expect(store.applications.replace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'screening', version: 2 }), 1, session,
    );
    expect(store.stages.append).toHaveBeenCalledWith(expect.objectContaining({
      from: 'applied', to: 'screening', resultingVersion: 2,
    }), session);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.application.stage_changed', version: 2,
    }), session);
    expect(result.application).toMatchObject({ stage: 'screening', version: 2 });
  });

  it('通用接口拒绝客户端自报 Offer 或雇佣证据', async () => {
    const store = fixture();
    await expect(store.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-key-002', {
        targetStage: 'offer_approval', evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z1',
      },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_DEDICATED_WORKFLOW_REQUIRED' },
    });
    expect(store.execute).not.toHaveBeenCalled();
  });

  it('读取同时执行部门数据范围，read_all 才能跨部门', async () => {
    const denied = fixture({ actorDepartments: ['department-002'] });
    await expect(denied.service.getApplication(APPLICATION_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_READ_DENIED' } });
    const allowed = fixture({
      actorDepartments: ['department-002'], actorScopes: ['erp:recruitment:application:read_all'],
    });
    await expect(allowed.service.getApplication(APPLICATION_ID))
      .resolves.toMatchObject({ id: APPLICATION_ID });
  });

  it('渠道回执投影只允许系统 Worker，并且不泄露候选人和证据字段', async () => {
    const denied = fixture({ actorScopes: ['erp:recruitment:channel:ack'] });
    await expect(denied.service.getApplicationForChannelDelivery(APPLICATION_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_CHANNEL_ACK_WORKER_REQUIRED' } });
    const allowed = fixture({
      actorType: 'system_job', actorScopes: ['erp:recruitment:channel:ack'],
    });
    const projection = await allowed.service.getApplicationForChannelDelivery(APPLICATION_ID);
    expect(projection).toEqual({ id: APPLICATION_ID, sourceChannel: 'portal', version: 1 });
    expect(projection).not.toHaveProperty('candidateId');
    expect(projection).not.toHaveProperty('consentEvidenceId');
  });
});
