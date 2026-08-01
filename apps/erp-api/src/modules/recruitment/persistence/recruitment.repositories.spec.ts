import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createCandidate, type Candidate } from '../domain/candidate.js';
import {
  createCandidateApplication,
  type CandidateApplication,
  type CandidateApplicationStageEvent,
} from '../domain/application.js';
import {
  createRecruitmentInterview,
  submitRecruitmentInterviewFeedback,
  type RecruitmentInterview,
} from '../domain/interview.js';
import { createRecruitmentOffer, type RecruitmentOffer } from '../domain/offer.js';
import {
  createRecruitmentOfferEvidence,
  type RecruitmentOfferEvidence,
} from '../domain/offer-evidence.js';
import {
  createRecruitmentPosition,
  type RecruitmentPosition,
} from '../domain/position.js';
import {
  createRecruitmentRequisition,
  type RecruitmentRequisition,
} from '../domain/requisition.js';
import { RecruitmentDataCryptoService } from './recruitment-data-crypto.service.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  CandidateConsentEvidenceRepository,
  RecruitmentCandidateRepository,
  RecruitmentInterviewFeedbackRepository,
  RecruitmentInterviewRepository,
  RecruitmentOfferEvidenceRepository,
  RecruitmentOfferRepository,
  RecruitmentPositionRepository,
  RecruitmentRequisitionRepository,
  RecruitmentWriteConflictError,
} from './recruitment.repositories.js';
import type {
  CandidateApplicationDocument,
  CandidateApplicationStageDocument,
  CandidateConsentEvidenceDocument,
  RecruitmentCandidateDocument,
  RecruitmentInterviewDocument,
  RecruitmentInterviewFeedbackDocument,
  RecruitmentOfferDocument,
  RecruitmentOfferEvidenceDocument,
  RecruitmentPositionDocument,
  RecruitmentRequisitionDocument,
} from './recruitment.schemas.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;

const candidate = createCandidate({
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
  tenantId: 'tenant-001',
  name: '张三',
  phone: '+8613800138000',
  email: 'candidate@example.com',
  consentEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
  consentVersion: 'privacy-v1',
  consentPurpose: '招聘评估与候选人联络',
  consentSource: 'portal',
  consentExpiresAt: new Date('2027-07-21T00:00:00.000Z'),
  retentionExpiresAt: new Date('2028-07-21T00:00:00.000Z'),
}, new Date('2026-07-21T00:00:00.000Z'));

function crypto(): RecruitmentDataCryptoService {
  const encryptionKey = randomBytes(32).toString('base64url');
  const blindKey = randomBytes(32).toString('base64url');
  return new RecruitmentDataCryptoService(new ConfigService<AppEnvironment, true>({
    RECRUITMENT_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'recruitment-key-001',
      keys: [{ keyId: 'recruitment-key-001', keyBase64url: encryptionKey, status: 'active' }],
    }),
    RECRUITMENT_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: 'blind-key-001',
      keys: [{ keyId: 'blind-key-001', keyBase64url: blindKey, status: 'active' }],
    }),
  } as AppEnvironment));
}

function context(): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
  } as unknown as TenantContextService;
}

function position(): RecruitmentPosition {
  return createRecruitmentPosition({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
    tenantId: 'tenant-001',
    requisitionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
    title: '内容策略经理',
    departmentId: 'department-001',
    jobLevelId: 'job-level-001',
    location: '上海',
    headcount: 2,
  }, NOW);
}

function requisition(): RecruitmentRequisition {
  return createRecruitmentRequisition({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
    tenantId: 'tenant-001',
    departmentId: 'department-001',
    positionTitle: '内容策略经理',
    headcount: 2,
    justification: '业务增长需要',
    actorId: 'actor-001',
  }, NOW);
}

function application(): CandidateApplication {
  return createCandidateApplication({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    tenantId: 'tenant-001',
    candidateId: candidate.id,
    positionId: position().id,
    consentEvidenceId: candidate.consent.evidenceId,
    sourceChannel: 'career_portal',
  }, NOW);
}

function interview(): RecruitmentInterview {
  return createRecruitmentInterview({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
    tenantId: 'tenant-001',
    applicationId: application().id,
    roundNumber: 1,
    mode: 'video',
    startsAt: new Date('2026-07-22T08:00:00.000Z'),
    endsAt: new Date('2026-07-22T09:00:00.000Z'),
    timezone: 'Asia/Shanghai',
    interviewerIds: ['employee-001'],
    location: 'https://meeting.example/secret-room',
    actorId: 'actor-001',
  }, NOW);
}

function offer(): RecruitmentOffer {
  return createRecruitmentOffer({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4X3',
    tenantId: 'tenant-001',
    applicationId: application().id,
    candidateId: candidate.id,
    positionId: position().id,
    completedInterviewId: interview().id,
    terms: {
      currency: 'CNY',
      monthlyBaseSalaryMinor: 3_000_000,
      salaryMonths: 13,
      annualVariableTargetMinor: 6_000_000,
      signingBonusMinor: 1_000_000,
      proposedStartDate: '2026-08-15',
      probationMonths: 3,
      employmentType: 'full_time',
      workLocation: '上海',
      benefitsSummary: '标准福利计划',
    },
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'),
    actorId: 'actor-001',
  }, NOW);
}

function offerEvidence(): RecruitmentOfferEvidence {
  return createRecruitmentOfferEvidence({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4X5',
    tenantId: 'tenant-001',
    offerId: offer().id,
    kind: 'sent',
    sendRequestId: 'send-request-001',
    proofHash: 'a'.repeat(43),
    occurredAt: NOW,
    actorId: 'actor-001',
  }, NOW);
}

describe('RecruitmentCandidateRepository', () => {
  it('插入时只写密文与盲索引，不把候选人原文交给 Mongo Model', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new RecruitmentCandidateRepository(
      context(), { create } as unknown as Model<RecruitmentCandidateDocument>, crypto(),
    );
    await repository.insert(candidate, { id: 'session' } as never);
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    const stored = records[0];
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('name');
    expect(stored).not.toHaveProperty('phone');
    expect(stored).not.toHaveProperty('email');
    expect(JSON.stringify(stored)).not.toMatch(/张三|13800138000|candidate@example/iu);
    expect(stored).toMatchObject({
      tenantId: 'tenant-001', identityKeyId: 'recruitment-key-001',
    });
  });

  it('密文与盲索引不一致时拒绝恢复候选人', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const dataCrypto = crypto();
    const writer = new RecruitmentCandidateRepository(
      context(), { create } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto,
    );
    await writer.insert(candidate, { id: 'session' } as never);
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    const stored = {
      ...records[0],
      phoneBlindIndexes: [`blind-key-001.${'a'.repeat(43)}`],
    };
    const findOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(stored) }),
    });
    const reader = new RecruitmentCandidateRepository(
      context(), { findOne } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto,
    );
    await expect(reader.findById(candidate.id)).rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');
    expect(findOne).toHaveBeenCalledWith({ tenantId: 'tenant-001', id: candidate.id });
  });

  it('读取、近期目录与联系方式检索只使用可信租户并支持会话', async () => {
    const dataCrypto = crypto();
    const create = vi.fn().mockResolvedValue(undefined);
    const writer = new RecruitmentCandidateRepository(
      context(),
      { create } as unknown as Model<RecruitmentCandidateDocument>,
      dataCrypto,
    );
    await writer.insert(candidate, SESSION);
    const stored = (create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    const execOne = vi.fn().mockResolvedValue(stored);
    const queryOne = {
      session: vi.fn(),
      lean: () => ({ exec: execOne }),
    };
    const findOne = vi.fn().mockReturnValue(queryOne);
    const repository = new RecruitmentCandidateRepository(
      context(),
      { findOne } as unknown as Model<RecruitmentCandidateDocument>,
      dataCrypto,
    );
    await expect(repository.findById(candidate.id, SESSION)).resolves.toEqual(candidate);
    expect(queryOne.session).toHaveBeenCalledWith(SESSION);

    const nullRepository = new RecruitmentCandidateRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
    } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto);
    await expect(nullRepository.findById('missing')).resolves.toBeNull();

    const recentExec = vi.fn().mockResolvedValue([stored]);
    const recentLimit = vi.fn().mockReturnValue({ lean: () => ({ exec: recentExec }) });
    const recentSort = vi.fn().mockReturnValue({ limit: recentLimit });
    const recentFind = vi.fn().mockReturnValue({ sort: recentSort });
    const recentRepository = new RecruitmentCandidateRepository(context(), {
      find: recentFind,
    } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto);
    await expect(recentRepository.findRecent(25)).resolves.toEqual([candidate]);
    expect(recentFind).toHaveBeenCalledWith({ tenantId: 'tenant-001' });
    expect(recentSort).toHaveBeenCalledWith({ updatedAt: -1, id: 1 });
    expect(recentLimit).toHaveBeenCalledWith(25);
    await expect(recentRepository.findRecent(0)).rejects.toThrow('候选人查询上限无效');

    await expect(recentRepository.findByContacts(null, null)).resolves.toEqual([]);
    const contactExec = vi.fn().mockResolvedValue([stored]);
    const contactQuery = {
      session: vi.fn(),
      lean: () => ({ exec: contactExec }),
    };
    recentFind.mockReturnValue(contactQuery);
    await expect(recentRepository.findByContacts(
      candidate.phone,
      candidate.email,
      SESSION,
    )).resolves.toEqual([candidate]);
    const contactFilter = recentFind.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(contactFilter).toMatchObject({
      tenantId: 'tenant-001',
      status: { $ne: 'anonymized' },
    });
    expect(contactFilter.$or).toEqual([
      { phoneBlindIndexes: { $in: dataCrypto.blindIndexes(
        'tenant-001',
        'phone',
        candidate.phone ?? '',
      ) } },
      { emailBlindIndexes: { $in: dataCrypto.blindIndexes(
        'tenant-001',
        'email',
        candidate.email ?? '',
      ) } },
    ]);
    expect(contactQuery.session).toHaveBeenCalledWith(SESSION);
  });

  it('匿名化写入销毁密文，替换执行版本门禁并拒绝跨租户', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new RecruitmentCandidateRepository(context(), {
      create,
      updateOne,
    } as unknown as Model<RecruitmentCandidateDocument>, crypto());
    const anonymized: Candidate = {
      ...candidate,
      status: 'anonymized',
      name: null,
      phone: null,
      email: null,
    };
    await repository.insert(anonymized, SESSION);
    const stored = (create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    expect(stored).toMatchObject({
      identityKeyId: null,
      phoneBlindIndexes: [],
      emailBlindIndexes: [],
    });
    await expect(repository.replace(anonymized, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(anonymized, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(repository.insert(
      { ...candidate, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('候选人可选联系方式、匿名化恢复和缺失身份字段均按完整性规则处理', async () => {
    const dataCrypto = crypto();
    const create = vi.fn().mockResolvedValue(undefined);
    const writer = new RecruitmentCandidateRepository(context(), {
      create,
    } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto);
    const phoneOnly: Candidate = { ...candidate, email: null };
    const emailOnly: Candidate = { ...candidate, phone: null };
    const anonymized: Candidate = {
      ...candidate,
      status: 'anonymized',
      name: null,
      phone: null,
      email: null,
    };
    await writer.insert(phoneOnly, SESSION);
    await writer.insert(emailOnly, SESSION);
    await writer.insert(anonymized, SESSION);
    const phoneStored = (create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    const emailStored = (create.mock.calls[1]?.[0] as Array<Record<string, unknown>>)[0];
    const anonymizedStored = (create.mock.calls[2]?.[0] as Array<Record<string, unknown>>)[0];
    expect(phoneStored?.emailBlindIndexes).toEqual([]);
    expect(emailStored?.phoneBlindIndexes).toEqual([]);

    const anonymizedReader = new RecruitmentCandidateRepository(context(), {
      findOne: () => ({
        lean: () => ({ exec: () => Promise.resolve(anonymizedStored) }),
      }),
    } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto);
    await expect(anonymizedReader.findById(candidate.id)).resolves.toEqual(anonymized);
    await expect(writer.insert(
      { ...candidate, name: null },
      SESSION,
    )).rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');

    const contactExec = vi.fn()
      .mockResolvedValueOnce([phoneStored])
      .mockResolvedValueOnce([emailStored]);
    const find = vi.fn().mockReturnValue({
      lean: () => ({ exec: contactExec }),
    });
    const contacts = new RecruitmentCandidateRepository(context(), {
      find,
    } as unknown as Model<RecruitmentCandidateDocument>, dataCrypto);
    await expect(contacts.findByContacts(candidate.phone, null)).resolves.toEqual([phoneOnly]);
    await expect(contacts.findByContacts(null, candidate.email)).resolves.toEqual([emailOnly]);
    const phoneFilter = find.mock.calls[0]?.[0] as {
      tenantId: string;
      $or: Array<Record<string, unknown>>;
    };
    expect(phoneFilter.tenantId).toBe('tenant-001');
    expect(phoneFilter.$or[0]).toHaveProperty('phoneBlindIndexes');
    const emailFilter = find.mock.calls[1]?.[0] as {
      $or: Array<Record<string, unknown>>;
    };
    expect(emailFilter.$or[0]).toHaveProperty('emailBlindIndexes');
  });
});

describe('CandidateConsentEvidenceRepository', () => {
  it('追加在线与迁移授权证据并按可信租户读取摘要', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const found = {
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/candidate-001',
      evidenceChecksum: 'a'.repeat(43),
    };
    const exec = vi.fn()
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce(null);
    const query = {
      select: vi.fn(),
      session: vi.fn(),
      lean: () => ({ exec }),
    };
    query.select.mockReturnValue(query);
    const findOne = vi.fn().mockReturnValue(query);
    const repository = new CandidateConsentEvidenceRepository(
      context(),
      { create, findOne } as unknown as Model<CandidateConsentEvidenceDocument>,
    );

    await repository.appendGranted(candidate, 'actor-001', SESSION);
    expect(create).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({
        tenantId: 'tenant-001',
        action: 'granted',
        migrationEvidenceRef: null,
      }),
    ], { session: SESSION });
    await expect(repository.findMigrationEvidenceById(
      candidate.consent.evidenceId,
      SESSION,
    )).resolves.toEqual(found);
    await expect(repository.findMigrationEvidenceById('missing')).resolves.toBeNull();
    expect(query.select).toHaveBeenCalledWith('migrationEvidenceRef evidenceChecksum -_id');
    expect(query.session).toHaveBeenCalledWith(SESSION);

    const migrated: Candidate = {
      ...candidate,
      consent: {
        ...candidate.consent,
        source: 'manual_import',
        withdrawnAt: '2026-07-22T00:00:00.000Z',
      },
    };
    await repository.appendMigrated(
      migrated,
      'actor-001',
      found.migrationEvidenceRef,
      found.evidenceChecksum,
      SESSION,
    );
    const migratedRecords = create.mock.calls[1]?.[0] as Array<Record<string, unknown>>;
    expect(migratedRecords).toHaveLength(2);
    expect(migratedRecords.map((record) => record.action)).toEqual(['granted', 'withdrawn']);
    await repository.appendMigrated(
      {
        ...migrated,
        consent: { ...migrated.consent, withdrawnAt: null },
      },
      'actor-001',
      found.migrationEvidenceRef,
      found.evidenceChecksum,
      SESSION,
    );
    expect(create.mock.calls[2]?.[0]).toHaveLength(1);
    await expect(repository.appendMigrated(
      candidate,
      'actor-001',
      found.migrationEvidenceRef,
      found.evidenceChecksum,
      SESSION,
    )).rejects.toThrow('迁移授权来源无效');
    await expect(repository.appendGranted(
      { ...candidate, tenantId: 'tenant-002' },
      'actor-001',
      SESSION,
    )).rejects.toThrow('跨租户');
  });
});

describe('RecruitmentPositionRepository', () => {
  it('门户查询强制当前租户与开放状态并限制返回数量', async () => {
    const records = [{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
      tenantId: 'tenant-001',
      requisitionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
      title: '内容策略经理',
      departmentId: 'department-001',
      jobLevelId: 'job-level-001',
      location: '上海',
      headcount: 2,
      status: 'open',
      version: 2,
      publishedAt: new Date('2026-07-24T08:00:00.000Z'),
      closedAt: null,
      createdAt: new Date('2026-07-23T08:00:00.000Z'),
      updatedAt: new Date('2026-07-24T08:00:00.000Z'),
    }];
    const exec = vi.fn().mockResolvedValue(records);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new RecruitmentPositionRepository(
      context(),
      { find } as unknown as Model<RecruitmentPositionDocument>,
    );

    const result = await repository.findOpen(50);

    expect(find).toHaveBeenCalledWith({ tenantId: 'tenant-001', status: 'open' });
    expect(sort).toHaveBeenCalledWith({ publishedAt: -1, id: 1 });
    expect(limit).toHaveBeenCalledWith(50);
    expect(result[0]).toMatchObject({
      title: '内容策略经理',
      status: 'open',
      publishedAt: '2026-07-24T08:00:00.000Z',
    });
    await expect(repository.findOpen(201)).rejects.toThrow('招聘门户职位查询上限无效');
  });

  it('职位读写执行租户、会话和乐观锁门禁', async () => {
    const value = position();
    const stored = {
      ...value,
      publishedAt: null,
      closedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const exec = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    const query = {
      session: vi.fn(),
      lean: () => ({ exec }),
    };
    const findOne = vi.fn().mockReturnValue(query);
    const create = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new RecruitmentPositionRepository(context(), {
      findOne,
      create,
      updateOne,
    } as unknown as Model<RecruitmentPositionDocument>);

    await expect(repository.findById(value.id, SESSION)).resolves.toEqual(value);
    await expect(repository.findById('missing')).resolves.toBeNull();
    expect(query.session).toHaveBeenCalledWith(SESSION);
    await repository.insert(value, SESSION);
    expect(create).toHaveBeenCalledWith([
      expect.objectContaining({ id: value.id, publishedAt: null, closedAt: null }),
    ], { session: SESSION });
    await expect(repository.replace(value, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(value, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(repository.insert(
      { ...value, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });
});

describe('RecruitmentRequisitionRepository', () => {
  it('HC 读写保持审批引用并执行版本与租户门禁', async () => {
    const value = requisition();
    const stored = {
      ...value,
      approvalHistoryId: undefined,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const exec = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    const query = {
      session: vi.fn(),
      lean: () => ({ exec }),
    };
    const findOne = vi.fn().mockReturnValue(query);
    const create = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new RecruitmentRequisitionRepository(context(), {
      findOne,
      create,
      updateOne,
    } as unknown as Model<RecruitmentRequisitionDocument>);

    await expect(repository.findById(value.id, SESSION)).resolves.toEqual(value);
    await expect(repository.findById('missing')).resolves.toBeNull();
    await repository.insert(value, SESSION);
    await expect(repository.replace(value, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(value, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(repository.insert(
      { ...value, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
    expect(query.session).toHaveBeenCalledWith(SESSION);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('CandidateApplicationRepositories', () => {
  it('申请读写、迁移摘要与阶段账本均绑定可信租户', async () => {
    const value = application();
    const stored = {
      ...value,
      active: true,
      appliedAt: NOW,
      endedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const evidence = {
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/application-001',
      migrationEvidenceChecksum: 'b'.repeat(43),
    };
    const execOne = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(null);
    const queryOne = {
      select: vi.fn(),
      session: vi.fn(),
      lean: () => ({ exec: execOne }),
    };
    queryOne.select.mockReturnValue(queryOne);
    const findOne = vi.fn().mockReturnValue(queryOne);
    const listExec = vi.fn().mockResolvedValue([stored]);
    const listQuery = {
      session: vi.fn(),
      lean: () => ({ exec: listExec }),
    };
    const sort = vi.fn().mockReturnValue(listQuery);
    const find = vi.fn().mockReturnValue({ sort });
    const create = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new CandidateApplicationRepository(context(), {
      findOne,
      find,
      create,
      updateOne,
    } as unknown as Model<CandidateApplicationDocument>);

    await expect(repository.findById(value.id, SESSION)).resolves.toEqual(value);
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findByCandidateId(candidate.id, SESSION)).resolves.toEqual([value]);
    expect(find).toHaveBeenCalledWith({ tenantId: 'tenant-001', candidateId: candidate.id });
    expect(sort).toHaveBeenCalledWith({ appliedAt: -1, id: 1 });
    await repository.insert(value, SESSION);
    await repository.insertMigrated(
      value,
      evidence.migrationEvidenceRef,
      evidence.migrationEvidenceChecksum,
      SESSION,
    );
    await expect(repository.findMigrationEvidenceById(value.id, SESSION))
      .resolves.toEqual(evidence);
    await expect(repository.findMigrationEvidenceById('missing')).resolves.toBeNull();
    await expect(repository.replace(value, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(value, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(repository.insert(
      { ...value, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');

    const event: CandidateApplicationStageEvent = {
      applicationId: value.id,
      tenantId: 'tenant-001',
      from: 'applied',
      to: 'screening',
      actorId: 'actor-001',
      reasonCode: null,
      evidenceId: null,
      resultingVersion: 2,
      occurredAt: '2026-07-21T01:00:00.000Z',
    };
    const stageStored = {
      ...event,
      id: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
      occurredAt: new Date(event.occurredAt),
    };
    const stageCreate = vi.fn().mockResolvedValue(undefined);
    const stageFind = vi.fn().mockReturnValue({
      sort: () => ({ lean: () => ({ exec: () => Promise.resolve([stageStored]) }) }),
    });
    const stages = new CandidateApplicationStageRepository(context(), {
      create: stageCreate,
      find: stageFind,
    } as unknown as Model<CandidateApplicationStageDocument>);
    await stages.append(event, SESSION);
    await expect(stages.findByApplicationId(value.id)).resolves.toEqual([event]);
    expect(stageFind).toHaveBeenCalledWith({ tenantId: 'tenant-001', applicationId: value.id });
    await expect(stages.append(
      { ...event, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });
});

describe('RecruitmentInterviewRepositories', () => {
  it('面试地点和评价原文在交给 Mongo Model 前已加密', async () => {
    const dataCrypto = crypto();
    const interviewCreate = vi.fn().mockResolvedValue(undefined);
    const feedbackCreate = vi.fn().mockResolvedValue(undefined);
    const scheduled = createRecruitmentInterview({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X1', tenantId: 'tenant-001',
      applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7', roundNumber: 1, mode: 'video',
      startsAt: new Date('2026-07-22T08:00:00.000Z'),
      endsAt: new Date('2026-07-22T09:00:00.000Z'), timezone: 'Asia/Shanghai',
      interviewerIds: ['employee-001'], location: 'https://meeting.example/secret-room',
      actorId: 'actor-001',
    }, new Date('2026-07-21T00:00:00.000Z'));
    const feedback = submitRecruitmentInterviewFeedback(scheduled, {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X2', tenantId: 'tenant-001', interviewerId: 'employee-001',
      expectedVersion: 1,
      recommendation: 'hire', score: 4, notes: '候选人经验与岗位高度匹配',
    }, new Date('2026-07-22T09:01:00.000Z'));
    await new RecruitmentInterviewRepository(
      context(), { create: interviewCreate } as unknown as Model<RecruitmentInterviewDocument>,
      dataCrypto,
    ).insert(scheduled, { id: 'session' } as never);
    await new RecruitmentInterviewFeedbackRepository(
      context(), { create: feedbackCreate } as unknown as Model<RecruitmentInterviewFeedbackDocument>,
      dataCrypto,
    ).append(feedback.feedback, { id: 'session' } as never);
    const storedInterview = interviewCreate.mock.calls[0]?.[0] as unknown;
    const storedFeedback = feedbackCreate.mock.calls[0]?.[0] as unknown;
    expect(JSON.stringify(storedInterview)).not.toContain('meeting.example');
    expect(JSON.stringify(storedFeedback)).not.toContain('候选人经验');
    const interviewRecords = storedInterview as readonly [{ readonly logisticsCiphertext: unknown }];
    const feedbackRecords = storedFeedback as readonly [{ readonly evaluationCiphertext: unknown }];
    expect(typeof interviewRecords[0].logisticsCiphertext).toBe('string');
    expect(typeof feedbackRecords[0].evaluationCiphertext).toBe('string');
  });

  it('面试和评价支持可信恢复、迁移摘要、会话读取与版本冲突', async () => {
    const dataCrypto = crypto();
    const scheduled = interview();
    const feedback = submitRecruitmentInterviewFeedback(scheduled, {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X2',
      tenantId: 'tenant-001',
      interviewerId: 'employee-001',
      expectedVersion: 1,
      recommendation: 'hire',
      score: 4,
      notes: '候选人经验与岗位高度匹配',
    }, new Date('2026-07-22T09:01:00.000Z')).feedback;
    const interviewCreate = vi.fn().mockResolvedValue(undefined);
    const feedbackCreate = vi.fn().mockResolvedValue(undefined);
    await new RecruitmentInterviewRepository(context(), {
      create: interviewCreate,
    } as unknown as Model<RecruitmentInterviewDocument>, dataCrypto).insertMigrated(
      scheduled,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/interview-001',
      'c'.repeat(43),
      SESSION,
    );
    await new RecruitmentInterviewFeedbackRepository(context(), {
      create: feedbackCreate,
    } as unknown as Model<RecruitmentInterviewFeedbackDocument>, dataCrypto).append(
      feedback,
      SESSION,
    );
    const storedInterview =
      (interviewCreate.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    const storedFeedback =
      (feedbackCreate.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];

    const interviewExec = vi.fn()
      .mockResolvedValueOnce(storedInterview)
      .mockResolvedValueOnce(null);
    const interviewQuery = {
      session: vi.fn(),
      lean: () => ({ exec: interviewExec }),
    };
    const evidenceExec = vi.fn()
      .mockResolvedValueOnce({
        migrationEvidenceRef: storedInterview?.migrationEvidenceRef,
        migrationEvidenceChecksum: storedInterview?.migrationEvidenceChecksum,
      })
      .mockResolvedValueOnce(null);
    const evidenceQuery = {
      select: vi.fn(),
      session: vi.fn(),
      lean: () => ({ exec: evidenceExec }),
    };
    evidenceQuery.select.mockReturnValue(evidenceQuery);
    const findOne = vi.fn()
      .mockReturnValueOnce(interviewQuery)
      .mockReturnValueOnce(interviewQuery)
      .mockReturnValueOnce(evidenceQuery)
      .mockReturnValueOnce(evidenceQuery);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const interviews = new RecruitmentInterviewRepository(context(), {
      findOne,
      updateOne,
    } as unknown as Model<RecruitmentInterviewDocument>, dataCrypto);
    await expect(interviews.findById(scheduled.id, SESSION)).resolves.toEqual(scheduled);
    await expect(interviews.findById('missing')).resolves.toBeNull();
    await expect(interviews.findMigrationEvidenceById(scheduled.id, SESSION)).resolves.toEqual({
      migrationEvidenceRef: storedInterview?.migrationEvidenceRef,
      migrationEvidenceChecksum: storedInterview?.migrationEvidenceChecksum,
    });
    await expect(interviews.findMigrationEvidenceById('missing')).resolves.toBeNull();
    await expect(interviews.replace(scheduled, 1, SESSION)).resolves.toBeUndefined();
    await expect(interviews.replace(scheduled, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(interviews.insert(
      { ...scheduled, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');

    const idsExec = vi.fn().mockResolvedValue([{ interviewerId: 'employee-001' }]);
    const idsQuery = {
      session: vi.fn(),
      lean: () => ({ exec: idsExec }),
    };
    const feedbackExec = vi.fn().mockResolvedValue([storedFeedback]);
    const feedbackQuery = {
      session: vi.fn(),
      lean: () => ({ exec: feedbackExec }),
    };
    const feedbackFind = vi.fn()
      .mockReturnValueOnce(idsQuery)
      .mockReturnValueOnce({ sort: () => feedbackQuery });
    const feedbacks = new RecruitmentInterviewFeedbackRepository(context(), {
      find: feedbackFind,
    } as unknown as Model<RecruitmentInterviewFeedbackDocument>, dataCrypto);
    await expect(feedbacks.findInterviewerIds(scheduled.id, SESSION))
      .resolves.toEqual(['employee-001']);
    await expect(feedbacks.findByInterview(scheduled.id, SESSION)).resolves.toEqual([feedback]);
    expect(idsQuery.session).toHaveBeenCalledWith(SESSION);
    expect(feedbackQuery.session).toHaveBeenCalledWith(SESSION);
    await expect(feedbacks.append(
      { ...feedback, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('面试地点和评价解密结构错位时失败关闭', async () => {
    const invalidCrypto = {
      unprotect: vi.fn()
        .mockReturnValueOnce({ mode: 'onsite', location: '错位地点' })
        .mockReturnValueOnce({ recommendation: 'hire', score: 9, notes: '越界' }),
    } as unknown as RecruitmentDataCryptoService;
    const interviewRecord = {
      id: interview().id,
      tenantId: 'tenant-001',
      mode: 'video',
      logisticsKeyId: 'key',
      logisticsIv: 'iv',
      logisticsCiphertext: 'cipher',
      logisticsAuthTag: 'tag',
    };
    const interviews = new RecruitmentInterviewRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(interviewRecord) }) }),
    } as unknown as Model<RecruitmentInterviewDocument>, invalidCrypto);
    await expect(interviews.findById(interview().id))
      .rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');

    const feedbacks = new RecruitmentInterviewFeedbackRepository(context(), {
      find: () => ({
        sort: () => ({
          lean: () => ({
            exec: () => Promise.resolve([{
              id: 'feedback-001',
              tenantId: 'tenant-001',
              interviewId: interview().id,
              interviewerId: 'employee-001',
              evaluationKeyId: 'key',
              evaluationIv: 'iv',
              evaluationCiphertext: 'cipher',
              evaluationAuthTag: 'tag',
              submittedAt: NOW,
            }]),
          }),
        }),
      }),
    } as unknown as Model<RecruitmentInterviewFeedbackDocument>, invalidCrypto);
    await expect(feedbacks.findByInterview(interview().id))
      .rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');
  });
});

describe('RecruitmentOfferRepository', () => {
  it('Offer L4 条款在交给 Mongo Model 前已整体加密', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const offer = createRecruitmentOffer({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X3', tenantId: 'tenant-001',
      applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      positionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8',
      completedInterviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
      terms: {
        currency: 'CNY', monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
        annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
        proposedStartDate: '2026-08-15', probationMonths: 3,
        employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
      },
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2033-08-01T00:00:00.000Z'), actorId: 'actor-001',
    }, new Date('2026-07-21T00:00:00.000Z'));
    const repository = new RecruitmentOfferRepository(
      context(), { create } as unknown as Model<RecruitmentOfferDocument>, crypto(),
    );
    await repository.insert(offer, { id: 'session' } as never);
    const stored = create.mock.calls[0]?.[0] as unknown;
    expect(JSON.stringify(stored)).not.toContain('标准福利计划');
    expect(JSON.stringify(stored)).not.toContain('monthlyBaseSalaryMinor');
    const records = stored as readonly [{ readonly termsCiphertext: unknown }];
    expect(typeof records[0].termsCiphertext).toBe('string');
    await repository.insertMigrated(
      offer,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/offer-001',
      'a'.repeat(43),
      { id: 'session' } as never,
    );
    const migrated = create.mock.calls[1]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(migrated[0]).toMatchObject({
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/offer-001',
      migrationEvidenceChecksum: 'a'.repeat(43),
    });
    expect(JSON.stringify(migrated)).not.toContain('标准福利计划');
  });

  it('Offer 可信恢复、迁移摘要、版本替换和租户门禁均失败关闭', async () => {
    const value = offer();
    const dataCrypto = crypto();
    const create = vi.fn().mockResolvedValue(undefined);
    await new RecruitmentOfferRepository(context(), {
      create,
    } as unknown as Model<RecruitmentOfferDocument>, dataCrypto).insertMigrated(
      value,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/offer-001',
      'a'.repeat(43),
      SESSION,
    );
    const stored = (create.mock.calls[0]?.[0] as Array<Record<string, unknown>>)[0];
    const offerExec = vi.fn()
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    const offerQuery = {
      session: vi.fn(),
      lean: () => ({ exec: offerExec }),
    };
    const evidence = {
      migrationEvidenceRef: stored?.migrationEvidenceRef,
      migrationEvidenceChecksum: stored?.migrationEvidenceChecksum,
    };
    const evidenceExec = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(null);
    const evidenceQuery = {
      select: vi.fn(),
      session: vi.fn(),
      lean: () => ({ exec: evidenceExec }),
    };
    evidenceQuery.select.mockReturnValue(evidenceQuery);
    const findOne = vi.fn()
      .mockReturnValueOnce(offerQuery)
      .mockReturnValueOnce(offerQuery)
      .mockReturnValueOnce(evidenceQuery)
      .mockReturnValueOnce(evidenceQuery);
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const repository = new RecruitmentOfferRepository(context(), {
      findOne,
      updateOne,
    } as unknown as Model<RecruitmentOfferDocument>, dataCrypto);

    await expect(repository.findById(value.id, SESSION)).resolves.toEqual(value);
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findMigrationEvidenceById(value.id, SESSION))
      .resolves.toEqual(evidence);
    await expect(repository.findMigrationEvidenceById('missing')).resolves.toBeNull();
    await expect(repository.replace(value, 1, SESSION)).resolves.toBeUndefined();
    await expect(repository.replace(value, 1, SESSION))
      .rejects.toBeInstanceOf(RecruitmentWriteConflictError);
    await expect(repository.insert(
      { ...value, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });

  it('Offer 解密条款缺字段或业务校验失败时拒绝恢复', async () => {
    const record = {
      id: offer().id,
      tenantId: 'tenant-001',
      termsKeyId: 'key',
      termsIv: 'iv',
      termsCiphertext: 'cipher',
      termsAuthTag: 'tag',
    };
    const malformedCrypto = {
      unprotect: () => ({ currency: 'CNY' }),
    } as unknown as RecruitmentDataCryptoService;
    const malformed = new RecruitmentOfferRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(record) }) }),
    } as unknown as Model<RecruitmentOfferDocument>, malformedCrypto);
    await expect(malformed.findById(offer().id))
      .rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');

    const invalidTermsCrypto = {
      unprotect: () => ({
        ...offer().terms,
        proposedStartDate: 'invalid-date',
      }),
    } as unknown as RecruitmentDataCryptoService;
    const invalid = new RecruitmentOfferRepository(context(), {
      findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(record) }) }),
    } as unknown as Model<RecruitmentOfferDocument>, invalidTermsCrypto);
    await expect(invalid.findById(offer().id))
      .rejects.toThrow('RECRUITMENT_DATA_INTEGRITY_INVALID');
  });
});

describe('RecruitmentOfferEvidenceRepository', () => {
  it('按租户读取迁移摘要并恢复严格 ISO 时间，不返回 Mongo 内部字段', async () => {
    const records = [{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4X5', tenantId: 'tenant-001',
      offerId: '01J8ZQK7V0A2M4N6P8R0T2W4X3', kind: 'signed', category: 'esign',
      source: 'migration_worm', subjectCandidateId: null, sendRequestId: null,
      authenticationEvidenceId: null, esignFlowId: 'esign-flow-001',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/offer-001',
      evidenceChecksum: 'a'.repeat(43), proofHash: 'b'.repeat(43),
      occurredAt: new Date('2026-07-21T04:00:00.000Z'), actorId: 'actor-001',
      recordedAt: new Date('2026-07-21T04:00:00.000Z'), _id: 'mongo-internal-id',
    }];
    const exec = vi.fn().mockResolvedValue(records);
    const sort = vi.fn().mockReturnValue({ lean: () => ({ exec }) });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new RecruitmentOfferEvidenceRepository(
      context(), { find } as unknown as Model<RecruitmentOfferEvidenceDocument>,
    );
    const result = await repository.findByOffer('01J8ZQK7V0A2M4N6P8R0T2W4X3');
    expect(find).toHaveBeenCalledWith({
      tenantId: 'tenant-001', offerId: '01J8ZQK7V0A2M4N6P8R0T2W4X3',
    });
    expect(sort).toHaveBeenCalledWith({ occurredAt: 1, id: 1 });
    expect(result[0]).toMatchObject({
      source: 'migration_worm', kind: 'signed',
      occurredAt: '2026-07-21T04:00:00.000Z', recordedAt: '2026-07-21T04:00:00.000Z',
    });
    expect(result[0]).not.toHaveProperty('_id');
  });

  it('Offer 证据追加和会话读取执行租户边界', async () => {
    const value = offerEvidence();
    const create = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockResolvedValue([{
      ...value,
      occurredAt: new Date(value.occurredAt),
      recordedAt: new Date(value.recordedAt),
    }]);
    const query = {
      session: vi.fn(),
      lean: () => ({ exec }),
    };
    const sort = vi.fn().mockReturnValue(query);
    const find = vi.fn().mockReturnValue({ sort });
    const repository = new RecruitmentOfferEvidenceRepository(context(), {
      create,
      find,
    } as unknown as Model<RecruitmentOfferEvidenceDocument>);

    await repository.append(value, SESSION);
    await expect(repository.findByOffer(value.offerId, SESSION)).resolves.toEqual([value]);
    expect(query.session).toHaveBeenCalledWith(SESSION);
    expect(create).toHaveBeenCalledWith([
      expect.objectContaining({
        id: value.id,
        occurredAt: new Date(value.occurredAt),
      }),
    ], { session: SESSION });
    await expect(repository.append(
      { ...value, tenantId: 'tenant-002' },
      SESSION,
    )).rejects.toThrow('跨租户');
  });
});
