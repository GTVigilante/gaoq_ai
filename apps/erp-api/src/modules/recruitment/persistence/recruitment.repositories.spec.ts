import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createCandidate } from '../domain/candidate.js';
import {
  createRecruitmentInterview,
  submitRecruitmentInterviewFeedback,
} from '../domain/interview.js';
import { RecruitmentDataCryptoService } from './recruitment-data-crypto.service.js';
import {
  RecruitmentCandidateRepository,
  RecruitmentInterviewFeedbackRepository,
  RecruitmentInterviewRepository,
} from './recruitment.repositories.js';
import type {
  RecruitmentCandidateDocument,
  RecruitmentInterviewDocument,
  RecruitmentInterviewFeedbackDocument,
} from './recruitment.schemas.js';

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
});
