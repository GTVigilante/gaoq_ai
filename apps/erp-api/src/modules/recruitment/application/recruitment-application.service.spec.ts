import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  RecruitmentWriteConflictError,
  type CandidateApplicationRepository,
  type CandidateApplicationStageRepository,
  type CandidateConsentEvidenceRepository,
  type RecruitmentCandidateRepository,
  type RecruitmentPositionRepository,
} from '../persistence/recruitment.repositories.js';
import type {
  Candidate,
  CandidateApplication,
} from '../domain/index.js';
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

const migratedCandidate = {
  id: application.candidateId, tenantId: 'tenant-001', status: 'active' as const,
  name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
  consent: {
    evidenceId: CONSENT_ID, version: 'privacy-v1', purpose: '招聘评估与候选人联络',
    source: 'manual_import' as const, capturedAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2027-07-20T00:00:00.000Z', withdrawnAt: null,
  },
  retentionExpiresAt: '2028-07-20T00:00:00.000Z', version: 1,
  createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
};

function fixture(options?: {
  readonly matches?: readonly Record<string, unknown>[];
  readonly actorDepartments?: readonly string[];
  readonly actorScopes?: readonly string[];
  readonly actorType?: 'user' | 'service' | 'system_job';
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
    findById: vi.fn().mockResolvedValue(migratedCandidate),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const consents = {
    appendGranted: vi.fn().mockResolvedValue(undefined),
    appendMigrated: vi.fn().mockResolvedValue(undefined),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
  };
  const positions = { findById: vi.fn().mockResolvedValue(position) };
  const applications = {
    insert: vi.fn().mockResolvedValue(undefined),
    insertMigrated: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(application),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
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

const candidateMigrationBase = {
  targetId: null as string | null,
  status: 'active' as const,
  name: '张三',
  phone: '+8613800138000',
  email: 'candidate@example.com',
  consentVersion: 'privacy-v1',
  consentPurpose: '招聘评估与候选人联络',
  consentCapturedAt: '2026-07-20T00:00:00.000Z',
  consentExpiresAt: '2027-07-20T00:00:00.000Z',
  consentWithdrawnAt: null as string | null,
  retentionExpiresAt: '2028-07-20T00:00:00.000Z',
  version: 1,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  migrationEvidenceRef:
    'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/candidate-evidence-001',
  evidenceChecksum: 'a'.repeat(43),
};

const applicationMigrationBase = {
  targetId: null as string | null,
  candidateId: migratedCandidate.id,
  positionId: POSITION_ID,
  sourceChannel: 'legacy_ats',
  actions: [
    {
      targetStage: 'screening' as const,
      reasonCode: null,
      occurredAt: '2026-07-20T01:00:00.000Z',
    },
    {
      targetStage: 'interview' as const,
      reasonCode: null,
      occurredAt: '2026-07-20T02:00:00.000Z',
    },
  ],
  expectedStage: 'interview' as const,
  expectedVersion: 3,
  appliedAt: '2026-07-20T00:00:00.000Z',
  endedAt: null as string | null,
  updatedAt: '2026-07-20T02:00:00.000Z',
  migrationEvidenceRef:
    'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/application-evidence-001',
  evidenceChecksum: 'b'.repeat(43),
};

const migratedApplication = {
  ...application,
  sourceChannel: 'legacy_ats',
  stage: 'interview' as const,
  version: 3,
  appliedAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T02:00:00.000Z',
};

describe('RecruitmentApplicationService', () => {
  it('候选人迁移只允许服务身份，写入加密仓储边界且响应和事件不含 PII', async () => {
    const input = {
      targetId: null,
      status: 'active' as const,
      name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
      consentVersion: 'privacy-v1', consentPurpose: '招聘评估与候选人联络',
      consentCapturedAt: '2026-07-20T00:00:00.000Z',
      consentExpiresAt: '2027-07-20T00:00:00.000Z', consentWithdrawnAt: null,
      retentionExpiresAt: '2028-07-20T00:00:00.000Z', version: 1,
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/candidate-evidence-001',
      evidenceChecksum: 'a'.repeat(43),
    };
    const denied = fixture({
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(denied.service.importCandidateFromMigration('candidate-migration-denied', input))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' } });

    const store = fixture({
      actorType: 'service',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const result = await store.service.importCandidateFromMigration(
      'candidate-migration-001', input,
    );
    const inserted = store.candidates.insert.mock.calls[0]?.[0] as unknown as {
      readonly tenantId: string; readonly status: string; readonly name: string;
      readonly phone: string; readonly email: string;
      readonly consent: { readonly source: string };
    };
    expect(inserted).toMatchObject({
      tenantId: 'tenant-001', status: 'active', name: '张三',
      phone: '+8613800138000', email: 'candidate@example.com',
      consent: { source: 'manual_import' },
    });
    expect(store.consents.appendMigrated).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001' }),
      'actor-001', input.migrationEvidenceRef, input.evidenceChecksum, session,
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string; readonly payload: Readonly<Record<string, unknown>>;
    };
    expect(event.type).toBe('recruitment.candidate.migrated');
    expect(event.payload).not.toHaveProperty('name');
    expect(JSON.stringify(result)).not.toMatch(/张三|13800138000|candidate@example/iu);
  });

  it('候选人迁移拒绝不完整服务权限和无效 WORM 证据', async () => {
    for (const actorScopes of [
      ['erp:migration:execute'],
      ['erp:recruitment:migration:write'],
    ]) {
      const denied = fixture({ actorType: 'service', actorScopes });
      await expect(denied.service.importCandidateFromMigration(
        `candidate-scope-${actorScopes[0]}`, candidateMigrationBase,
      )).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' },
      });
      expect(denied.execute).not.toHaveBeenCalled();
    }

    const writer = fixture({
      actorType: 'service',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    await expect(writer.service.importCandidateFromMigration('candidate-evidence-ref', {
      ...candidateMigrationBase,
      migrationEvidenceRef: 'https://untrusted.example/evidence',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_CANDIDATE_EVIDENCE_INVALID' },
    });
    await expect(writer.service.importCandidateFromMigration('candidate-evidence-checksum', {
      ...candidateMigrationBase,
      evidenceChecksum: 'not-a-checksum',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_CANDIDATE_EVIDENCE_INVALID' },
    });
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it('候选人迁移目标只允许与既有主档及 WORM 证据完全一致的幂等重放', async () => {
    const input = { ...candidateMigrationBase, targetId: migratedCandidate.id };
    const replay = fixture({
      actorType: 'system_job',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    replay.consents.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      evidenceChecksum: input.evidenceChecksum,
    });
    await expect(replay.service.importCandidateFromMigration(
      'candidate-replay-equal', input,
    )).resolves.toMatchObject({
      candidate: { id: migratedCandidate.id, consentEvidenceId: CONSENT_ID, version: 1 },
    });
    expect(replay.candidates.insert).not.toHaveBeenCalled();
    expect(replay.consents.appendMigrated).not.toHaveBeenCalled();
    expect(replay.outbox.append).not.toHaveBeenCalled();

    const cases: readonly {
      readonly name: string;
      readonly candidate: Candidate | null;
      readonly evidence: { readonly migrationEvidenceRef: string; readonly evidenceChecksum: string } | null;
    }[] = [
      { name: 'missing-target', candidate: null, evidence: null },
      { name: 'missing-evidence', candidate: migratedCandidate, evidence: null },
      {
        name: 'candidate-mismatch',
        candidate: { ...migratedCandidate, updatedAt: '2026-07-20T00:00:01.000Z' },
        evidence: {
          migrationEvidenceRef: input.migrationEvidenceRef,
          evidenceChecksum: input.evidenceChecksum,
        },
      },
      {
        name: 'reference-mismatch',
        candidate: migratedCandidate,
        evidence: {
          migrationEvidenceRef: `${input.migrationEvidenceRef}-other`,
          evidenceChecksum: input.evidenceChecksum,
        },
      },
      {
        name: 'checksum-mismatch',
        candidate: migratedCandidate,
        evidence: {
          migrationEvidenceRef: input.migrationEvidenceRef,
          evidenceChecksum: 'c'.repeat(43),
        },
      },
    ];
    for (const item of cases) {
      const store = fixture({
        actorType: 'service',
        actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
      });
      store.candidates.findById.mockResolvedValue(item.candidate);
      store.consents.findMigrationEvidenceById.mockResolvedValue(item.evidence);
      await expect(store.service.importCandidateFromMigration(
        `candidate-replay-${item.name}`, input,
      )).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_CANDIDATE_IMMUTABLE' },
      });
      expect(store.candidates.insert).not.toHaveBeenCalled();
    }
  });

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

  it('申请迁移验证候选人授权和职位后只写基线与迁移事件', async () => {
    const store = fixture({
      actorType: 'system_job',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const input = {
      targetId: null,
      candidateId: migratedCandidate.id,
      positionId: POSITION_ID,
      sourceChannel: 'legacy_ats',
      actions: [
        { targetStage: 'screening' as const, reasonCode: null, occurredAt: '2026-07-20T01:00:00.000Z' },
        { targetStage: 'interview' as const, reasonCode: null, occurredAt: '2026-07-20T02:00:00.000Z' },
      ],
      expectedStage: 'interview' as const,
      expectedVersion: 3,
      appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
      updatedAt: '2026-07-20T02:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/application-evidence-001',
      evidenceChecksum: 'b'.repeat(43),
    };

    const result = await store.service.importApplicationBaselineFromMigration(
      'application-migration-001', input,
    );

    expect(store.applications.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: migratedCandidate.id, positionId: POSITION_ID,
        consentEvidenceId: CONSENT_ID, stage: 'interview', version: 3,
      }),
      input.migrationEvidenceRef, input.evidenceChecksum, session,
    );
    expect(store.stages.append).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.application.migrated',
    }), session);
    expect(result.application).toMatchObject({ stage: 'interview', version: 3 });
    expect(JSON.stringify(result)).not.toMatch(/张三|13800138000|candidate@example/iu);
  });

  it('申请迁移拒绝无效证据以及失效的活动申请引用', async () => {
    const writer = () => fixture({
      actorType: 'system_job',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const invalidEvidence = writer();
    await expect(invalidEvidence.service.importApplicationBaselineFromMigration(
      'application-invalid-evidence',
      { ...applicationMigrationBase, evidenceChecksum: 'bad' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_MIGRATION_APPLICATION_EVIDENCE_INVALID' },
    });
    expect(invalidEvidence.execute).not.toHaveBeenCalled();

    const references: readonly {
      readonly name: string;
      readonly candidate: Candidate | null;
      readonly currentPosition: typeof position | null;
    }[] = [
      { name: 'candidate-missing', candidate: null, currentPosition: position },
      { name: 'position-missing', candidate: migratedCandidate, currentPosition: null },
      {
        name: 'candidate-inactive',
        candidate: { ...migratedCandidate, status: 'withdrawn' },
        currentPosition: position,
      },
      {
        name: 'consent-expired',
        candidate: {
          ...migratedCandidate,
          consent: { ...migratedCandidate.consent, expiresAt: '2025-07-20T00:00:00.000Z' },
        },
        currentPosition: position,
      },
      {
        name: 'position-closed',
        candidate: migratedCandidate,
        currentPosition: { ...position, status: 'closed' },
      },
    ];
    for (const item of references) {
      const store = writer();
      store.candidates.findById.mockResolvedValue(item.candidate);
      store.positions.findById.mockResolvedValue(item.currentPosition);
      await expect(store.service.importApplicationBaselineFromMigration(
        `application-reference-${item.name}`, applicationMigrationBase,
      )).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_APPLICATION_REFERENCE_INVALID' },
      });
      expect(store.applications.insertMigrated).not.toHaveBeenCalled();
    }
  });

  it('终态申请迁移可保留历史失效引用，活动态仍坚持有效授权', async () => {
    const store = fixture({
      actorType: 'service',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    store.candidates.findById.mockResolvedValue({
      ...migratedCandidate,
      status: 'withdrawn',
      consent: { ...migratedCandidate.consent, expiresAt: '2025-07-20T00:00:00.000Z' },
    });
    store.positions.findById.mockResolvedValue({ ...position, status: 'closed' });
    const terminal = {
      ...applicationMigrationBase,
      actions: [
        applicationMigrationBase.actions[0],
        {
          targetStage: 'rejected' as const,
          reasonCode: 'LEGACY_REJECTED',
          occurredAt: '2026-07-20T02:00:00.000Z',
        },
      ],
      expectedStage: 'rejected' as const,
      endedAt: '2026-07-20T02:00:00.000Z',
    };
    await expect(store.service.importApplicationBaselineFromMigration(
      'application-terminal-history', terminal,
    )).resolves.toMatchObject({ application: { stage: 'rejected', version: 3 } });
    expect(store.applications.insertMigrated).toHaveBeenCalledOnce();
  });

  it('申请迁移目标只允许与既有基线及 WORM 证据完全一致的幂等重放', async () => {
    const input = { ...applicationMigrationBase, targetId: APPLICATION_ID };
    const writer = () => fixture({
      actorType: 'system_job',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const replay = writer();
    replay.applications.findById.mockResolvedValue(migratedApplication);
    replay.applications.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    await expect(replay.service.importApplicationBaselineFromMigration(
      'application-replay-equal', input,
    )).resolves.toMatchObject({
      application: { id: APPLICATION_ID, stage: 'interview', version: 3 },
    });
    expect(replay.applications.insertMigrated).not.toHaveBeenCalled();
    expect(replay.outbox.append).not.toHaveBeenCalled();

    const cases: readonly {
      readonly name: string;
      readonly current: CandidateApplication | null;
      readonly evidence: {
        readonly migrationEvidenceRef: string;
        readonly migrationEvidenceChecksum: string;
      } | null;
    }[] = [
      { name: 'missing-target', current: null, evidence: null },
      { name: 'missing-evidence', current: migratedApplication, evidence: null },
      {
        name: 'baseline-mismatch',
        current: { ...migratedApplication, updatedAt: '2026-07-20T02:00:01.000Z' },
        evidence: {
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
        },
      },
      {
        name: 'reference-mismatch',
        current: migratedApplication,
        evidence: {
          migrationEvidenceRef: `${input.migrationEvidenceRef}-other`,
          migrationEvidenceChecksum: input.evidenceChecksum,
        },
      },
      {
        name: 'checksum-mismatch',
        current: migratedApplication,
        evidence: {
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: 'c'.repeat(43),
        },
      },
    ];
    for (const item of cases) {
      const store = writer();
      store.applications.findById.mockResolvedValue(item.current);
      store.applications.findMigrationEvidenceById.mockResolvedValue(item.evidence);
      await expect(store.service.importApplicationBaselineFromMigration(
        `application-replay-${item.name}`, input,
      )).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_MIGRATION_APPLICATION_IMMUTABLE' },
      });
      expect(store.applications.insertMigrated).not.toHaveBeenCalled();
    }
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

  it('申请创建对职位状态、日期和唯一键冲突使用稳定错误契约', async () => {
    const missing = fixture();
    missing.positions.findById.mockResolvedValueOnce(null);
    await expect(missing.service.createApplication('create-position-missing', createInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_POSITION_NOT_FOUND' } });

    const paused = fixture();
    paused.positions.findById.mockResolvedValueOnce({ ...position, status: 'paused' });
    await expect(paused.service.createApplication('create-position-paused', createInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_POSITION_NOT_OPEN' } });

    const invalidDate = fixture();
    await expect(invalidDate.service.createApplication('create-invalid-date', {
      ...createInput,
      consent: { ...createInput.consent, expiresAt: 'invalid-date' },
    })).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INVALID_DATE' } });

    const duplicate = fixture();
    duplicate.applications.insert.mockRejectedValueOnce({ code: 11_000 });
    await expect(duplicate.service.createApplication('create-duplicate', createInput))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_UNIQUE_CONFLICT' } });
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

  it('阶段推进按职位部门强制写范围，write_all 才能跨部门', async () => {
    const denied = fixture({ actorDepartments: ['department-002'] });
    await expect(denied.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-department-denied', { targetStage: 'screening' },
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_APPLICATION_WRITE_DENIED' },
    });
    expect(denied.positions.findById).toHaveBeenCalledWith(POSITION_ID, session);
    expect(denied.applications.replace).not.toHaveBeenCalled();
    expect(denied.stages.append).not.toHaveBeenCalled();
    expect(denied.outbox.append).not.toHaveBeenCalled();

    const allowed = fixture({
      actorDepartments: ['department-002'],
      actorScopes: ['erp:recruitment:management:write_all'],
    });
    await expect(allowed.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-write-all', { targetStage: 'screening' },
    )).resolves.toMatchObject({ application: { stage: 'screening' } });
  });

  it('阶段推进在职位引用丢失时失败关闭且不写聚合', async () => {
    const store = fixture();
    store.positions.findById.mockResolvedValueOnce(null);
    await expect(store.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-position-missing', { targetStage: 'screening' },
    )).rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');
    expect(store.applications.replace).not.toHaveBeenCalled();
    expect(store.stages.append).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('阶段推进统一映射仓储冲突、领域冲突、租户越权和非法迁移', async () => {
    const writeConflict = fixture();
    writeConflict.applications.replace.mockRejectedValueOnce(new RecruitmentWriteConflictError());
    await expect(writeConflict.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-write-conflict', { targetStage: 'screening' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const versionConflict = fixture();
    await expect(versionConflict.service.transitionApplication(
      APPLICATION_ID, 2, 'transition-version-conflict', { targetStage: 'screening' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_VERSION_CONFLICT' } });

    const tenantMismatch = fixture();
    tenantMismatch.applications.findById.mockResolvedValueOnce({
      ...application,
      tenantId: 'tenant-other',
    });
    await expect(tenantMismatch.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-tenant-mismatch', { targetStage: 'screening' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_TENANT_MISMATCH' } });

    const invalidTransition = fixture();
    await expect(invalidTransition.service.transitionApplication(
      APPLICATION_ID, 1, 'transition-invalid', { targetStage: 'interview' },
    )).rejects.toMatchObject({ response: { code: 'CANDIDATE_STAGE_TRANSITION_INVALID' } });
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

  it('读取对申请缺失和职位引用失效采用失败关闭', async () => {
    const missingApplication = fixture();
    missingApplication.applications.findById.mockResolvedValueOnce(null);
    await expect(missingApplication.service.getApplication(APPLICATION_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPLICATION_NOT_FOUND' } });

    const missingPosition = fixture();
    missingPosition.positions.findById.mockResolvedValueOnce(null);
    await expect(missingPosition.service.getApplication(APPLICATION_ID))
      .rejects.toThrow('RECRUITMENT_POSITION_REFERENCE_INVALID');
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
