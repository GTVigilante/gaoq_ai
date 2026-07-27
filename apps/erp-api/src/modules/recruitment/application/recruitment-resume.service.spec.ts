import type { Queue } from 'bullmq';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { RecruitmentResumeAnalysisJobData } from '../recruitment-resume.queue.js';
import type {
  RecruitmentResumeAnalysisDocument,
} from '../persistence/recruitment-resume.schemas.js';
import type { RecruitmentCandidateRepository } from '../persistence/recruitment.repositories.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  RecruitmentResumeAiAnalyzer,
  RecruitmentResumeSourceGateway,
} from './recruitment-resume.ports.js';
import { RecruitmentResumeService } from './recruitment-resume.service.js';

const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const ANALYSIS_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E2';

function trusted<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'recruiter-001',
      actorType: 'user',
      tenantId: 'tenant-001',
      roleCodes: ['RECRUITER'],
      scopes: ['erp:recruitment:resume:read'],
      departmentIds: [],
      traceId: 'trace-resume-001',
    },
  }, action);
}

function workerTrusted<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'system_job' },
    actor: {
      actorId: 'recruitment-resume-worker',
      actorType: 'system_job',
      tenantId: 'tenant-001',
      roleCodes: [],
      scopes: ['erp:recruitment:resume:process'],
      departmentIds: [],
      traceId: 'trace-resume-worker-001',
    },
  }, action);
}

describe('RecruitmentResumeService', () => {
  it('发起分析时从可信租户校验候选人并异步入队', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue(undefined);
    const records = {
      findOne: vi.fn().mockReturnValue({
        session: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      }),
      create,
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    let storedResponse: Record<string, unknown> | null = null;
    const idempotency = {
      execute: vi.fn().mockImplementation(
        (
          _operation: string,
          _key: string,
          _request: unknown,
          handler: (session: ClientSession) => Promise<Record<string, unknown>>,
        ) => handler({} as ClientSession).then((result) => {
          storedResponse = result;
          return result;
        }),
      ),
    };
    const service = new RecruitmentResumeService(
      context,
      idempotency as unknown as IdempotencyService,
      candidateRepository(),
      { append: vi.fn().mockResolvedValue(undefined) } as unknown as RecruitmentOutboxWriter,
      records as unknown as Model<RecruitmentResumeAnalysisDocument>,
      queue as unknown as Queue<RecruitmentResumeAnalysisJobData>,
      {} as RecruitmentResumeSourceGateway,
      {} as RecruitmentResumeAiAnalyzer,
    );

    const result = await trusted(context, () => service.requestAnalysis(
      'resume-key-001',
      CANDIDATE_ID,
      { resumeEvidenceId: 'resume-evidence-001' },
    ));

    expect(create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001',
        candidateId: CANDIDATE_ID,
        status: 'queued',
        profile: null,
        tags: [],
      }),
    ], { session: {} });
    expect(queue.add).toHaveBeenCalledWith(
      'analyze:recruitment:resume',
      expect.objectContaining({ tenantId: 'tenant-001', analysisId: result.analysis.id }),
      expect.objectContaining({ attempts: 5 }),
    );
    expect(result.analysis.candidateName).toBe('候选人甲');
    expect(JSON.stringify(storedResponse)).not.toContain('候选人甲');
  });

  it('Worker 只持久化结构结果与受控标签，不持久化脱敏正文', async () => {
    const context = new TenantContextService();
    const now = new Date();
    const claimed = analysisRecord({
      status: 'processing',
      version: 2,
      processingStartedAt: now,
      attempts: 1,
    });
    const completed = analysisRecord({
      status: 'review_required',
      version: 3,
      profile: {
        headline: '高级后端研发',
        summary: '企业级系统研发经历',
        yearsExperience: 5,
        educationLevel: 'bachelor',
        skills: ['TypeScript'],
        jobTitles: ['后端工程师'],
        industries: ['SaaS'],
        languages: ['中文'],
      },
      tags: [{
        category: 'role_family',
        code: 'role_engineering',
        label: '研发',
        confidence: 0.95,
        evidence: '五年后端研发经历',
        source: 'ai',
        status: 'suggested',
      }],
      aiModel: 'gpt-5.6-luna',
      sourceChecksum: 'a'.repeat(43),
      analyzedAt: now,
    });
    const records = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce({ lean: () => ({ exec: () => Promise.resolve(claimed) }) })
        .mockReturnValueOnce({ lean: () => ({ exec: () => Promise.resolve(completed) }) }),
      updateOne: vi.fn(),
    };
    const source = {
      readRedactedText: vi.fn().mockResolvedValue({
        candidateId: CANDIDATE_ID,
        resumeEvidenceId: 'resume-evidence-001',
        sourceChecksum: 'a'.repeat(43),
        mimeType: 'application/pdf',
        text: '这段脱敏正文只应存在于 Worker 内存',
      }),
    };
    const ai = {
      analyze: vi.fn().mockResolvedValue({
        model: 'gpt-5.6-luna',
        headline: '高级后端研发',
        summary: '企业级系统研发经历',
        yearsExperience: 5,
        educationLevel: 'bachelor',
        skills: ['TypeScript'],
        jobTitles: ['后端工程师'],
        industries: ['SaaS'],
        languages: ['中文'],
        tags: [{
          code: 'role_engineering',
          confidence: 0.95,
          evidence: '五年后端研发经历',
        }],
      }),
    };
    const service = new RecruitmentResumeService(
      context,
      {} as IdempotencyService,
      candidateRepository(),
      { append: vi.fn() } as unknown as RecruitmentOutboxWriter,
      records as unknown as Model<RecruitmentResumeAnalysisDocument>,
      {} as Queue<RecruitmentResumeAnalysisJobData>,
      source,
      ai,
    );

    const result = await workerTrusted(context, () => service.processAnalysis(ANALYSIS_ID));

    expect(result).toMatchObject({ status: 'review_required', aiModel: 'gpt-5.6-luna' });
    const update = records.findOneAndUpdate.mock.calls[1]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'review_required',
      sourceChecksum: 'a'.repeat(43),
    });
    expect(JSON.stringify(update)).not.toContain('这段脱敏正文');
    expect(update.$set.tags).toEqual([
      expect.objectContaining({ code: 'role_engineering', status: 'suggested' }),
    ]);
  });

  it('普通用户即使伪造 Worker Scope 也不能执行简历分析', async () => {
    const context = new TenantContextService();
    const records = { findOneAndUpdate: vi.fn() };
    const service = new RecruitmentResumeService(
      context,
      {} as IdempotencyService,
      candidateRepository(),
      { append: vi.fn() } as unknown as RecruitmentOutboxWriter,
      records as unknown as Model<RecruitmentResumeAnalysisDocument>,
      {} as Queue<RecruitmentResumeAnalysisJobData>,
      {} as RecruitmentResumeSourceGateway,
      {} as RecruitmentResumeAiAnalyzer,
    );

    await expect(context.run({
      tenant: { tenantId: 'tenant-001', source: 'access_token' },
      actor: {
        actorId: 'spoofed-user',
        actorType: 'user',
        tenantId: 'tenant-001',
        roleCodes: [],
        scopes: ['erp:recruitment:resume:process'],
        departmentIds: [],
        traceId: 'trace-spoofed-worker',
      },
    }, () => service.processAnalysis(ANALYSIS_ID))).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_RESUME_PROCESSOR_DENIED' },
    });
    expect(records.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

function candidateRepository(): RecruitmentCandidateRepository {
  return {
    findById: vi.fn().mockResolvedValue({
      id: CANDIDATE_ID,
      tenantId: 'tenant-001',
      status: 'active',
      name: '候选人甲',
      phone: null,
      email: 'candidate@example.com',
      consent: {
        evidenceId: ANALYSIS_ID,
        version: 'v1',
        purpose: '招聘处理',
        source: 'portal',
        capturedAt: '2026-07-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        withdrawnAt: null,
      },
      retentionExpiresAt: '2099-01-01T00:00:00.000Z',
      version: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }),
  } as unknown as RecruitmentCandidateRepository;
}

function analysisRecord(overrides: Record<string, unknown>) {
  return {
    id: ANALYSIS_ID,
    tenantId: 'tenant-001',
    candidateId: CANDIDATE_ID,
    resumeEvidenceId: 'resume-evidence-001',
    promptVersion: 'resume_v1',
    status: 'queued',
    profile: null,
    tags: [],
    aiModel: null,
    sourceChecksum: null,
    failureCode: null,
    processingStartedAt: null,
    analyzedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    attempts: 0,
    version: 1,
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    ...overrides,
  };
}
