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
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
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

function queryResult<T>(value: T) {
  const terminal = { exec: vi.fn().mockResolvedValue(value) };
  const lean = vi.fn().mockReturnValue(terminal);
  return {
    session: vi.fn().mockReturnValue({ lean }),
    lean,
  };
}

function listQueryResult<T>(value: T) {
  const terminal = { exec: vi.fn().mockResolvedValue(value) };
  const lean = vi.fn().mockReturnValue(terminal);
  const limit = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ limit });
  return { sort, limit, lean };
}

function serviceFixture() {
  const context = new TenantContextService();
  const candidate = candidateRecord();
  const findCandidateById = vi.fn().mockResolvedValue(candidate);
  const candidates = { findById: findCandidateById };
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler({} as ClientSession),
  );
  const findOne = vi.fn().mockReturnValue(queryResult(null));
  const find = vi.fn().mockReturnValue(listQueryResult([]));
  const findOneAndUpdate = vi.fn().mockReturnValue(queryResult(null));
  const updateOne = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  });
  const analyses = {
    findOne,
    find,
    findOneAndUpdate,
    updateOne,
    create: vi.fn().mockResolvedValue(undefined),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const source = {
    readRedactedText: vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      resumeEvidenceId: 'resume-evidence-001',
      sourceChecksum: 'a'.repeat(43),
      mimeType: 'application/pdf',
      text: '仅存在于 Worker 内存的脱敏文本',
    }),
  };
  const ai = {
    analyze: vi.fn().mockResolvedValue({
      model: 'gpt-test',
      headline: '高级研发',
      summary: '企业系统经验',
      yearsExperience: 5,
      educationLevel: 'bachelor',
      skills: ['TypeScript'],
      jobTitles: ['后端工程师'],
      industries: ['SaaS'],
      languages: ['中文'],
      tags: [{ code: 'role_engineering', confidence: 0.9, evidence: '研发经历' }],
    }),
  };
  const service = new RecruitmentResumeService(
    context,
    { execute } as unknown as IdempotencyService,
    candidates as unknown as RecruitmentCandidateRepository,
    outbox as unknown as RecruitmentOutboxWriter,
    analyses as unknown as Model<RecruitmentResumeAnalysisDocument>,
    queue as unknown as Queue<RecruitmentResumeAnalysisJobData>,
    source,
    ai,
  );
  return {
    context,
    service,
    execute,
    findCandidateById,
    analyses,
    queue,
    outbox,
    source,
    ai,
  };
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
    const analyzerInput = ai.analyze.mock.calls[0]?.[0] as unknown as {
      readonly safetyIdentifier?: unknown;
    };
    expect(analyzerInput.safetyIdentifier).toBeTypeOf('string');
    expect(analyzerInput.safetyIdentifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  it('分析请求严格校验标识、证据和候选人授权有效期', async () => {
    const invalidId = serviceFixture();
    await expect(trusted(invalidId.context, () => invalidId.service.requestAnalysis(
      'request-invalid-id', 'invalid', { resumeEvidenceId: 'resume-evidence-001' },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    const invalidEvidence = serviceFixture();
    await expect(trusted(invalidEvidence.context, () => invalidEvidence.service.requestAnalysis(
      'request-invalid-evidence', CANDIDATE_ID, { resumeEvidenceId: 'invalid evidence' },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    for (const candidate of [
      null,
      { ...candidateRecord(), status: 'withdrawn' },
      { ...candidateRecord(), name: null },
      {
        ...candidateRecord(),
        consent: { ...candidateRecord().consent, expiresAt: '2020-01-01T00:00:00.000Z' },
      },
      { ...candidateRecord(), retentionExpiresAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const ineligible = serviceFixture();
      ineligible.findCandidateById.mockResolvedValueOnce(candidate);
      await expect(trusted(ineligible.context, () => ineligible.service.requestAnalysis(
        `request-ineligible-${String(candidate?.status ?? 'missing')}`,
        CANDIDATE_ID,
        { resumeEvidenceId: 'resume-evidence-001' },
      ))).rejects.toMatchObject({
        response: { code: 'RECRUITMENT_RESUME_CANDIDATE_NOT_ELIGIBLE' },
      });
      expect(ineligible.execute).not.toHaveBeenCalled();
    }
  });

  it('既有分析按幂等状态决定是否恢复队列', async () => {
    const queued = serviceFixture();
    queued.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({ status: 'queued' })));
    const queuedResult = await trusted(queued.context, () => queued.service.requestAnalysis(
      'request-existing-queued', CANDIDATE_ID, { resumeEvidenceId: 'resume-evidence-001' },
    ));
    expect(queuedResult.analysis.candidateName).toBe('候选人甲');
    expect(queued.analyses.create).not.toHaveBeenCalled();
    expect(queued.outbox.append).not.toHaveBeenCalled();
    expect(queued.queue.add).toHaveBeenCalledTimes(1);

    const approved = serviceFixture();
    approved.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'approved',
    })));
    await trusted(approved.context, () => approved.service.requestAnalysis(
      'request-existing-approved', CANDIDATE_ID, { resumeEvidenceId: 'resume-evidence-001' },
    ));
    expect(approved.queue.add).not.toHaveBeenCalled();

    const retryableFailure = serviceFixture();
    retryableFailure.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'failed',
      attempts: 4,
    })));
    await trusted(retryableFailure.context, () => retryableFailure.service.requestAnalysis(
      'request-existing-retryable', CANDIDATE_ID, { resumeEvidenceId: 'resume-evidence-001' },
    ));
    expect(retryableFailure.queue.add).toHaveBeenCalledTimes(1);

    const exhaustedFailure = serviceFixture();
    exhaustedFailure.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'failed',
      attempts: 5,
    })));
    await trusted(exhaustedFailure.context, () => exhaustedFailure.service.requestAnalysis(
      'request-existing-exhausted', CANDIDATE_ID, { resumeEvidenceId: 'resume-evidence-001' },
    ));
    expect(exhaustedFailure.queue.add).not.toHaveBeenCalled();
  });

  it('可信证据入口同时限制主体类型和附件链 Scope', async () => {
    const denied = serviceFixture();
    await expect(trusted(denied.context, () => denied.service.requestAnalysisFromTrustedEvidence(
      'trusted-evidence-user', CANDIDATE_ID, 'resume-evidence-001',
    ))).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_RESUME_TRUSTED_EVIDENCE_REQUIRED' },
    });

    const missingScope = serviceFixture();
    await expect(missingScope.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'attachment-worker',
        actorType: 'system_job',
        tenantId: 'tenant-001',
        roleCodes: [],
        scopes: [],
        departmentIds: [],
        traceId: 'trace-attachment-worker',
      },
    }, () => missingScope.service.requestAnalysisFromTrustedEvidence(
      'trusted-evidence-scope-missing', CANDIDATE_ID, 'resume-evidence-001',
    ))).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_RESUME_TRUSTED_EVIDENCE_REQUIRED' },
    });

    const allowed = serviceFixture();
    allowed.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'approved',
    })));
    await expect(allowed.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'channel-service',
        actorType: 'service',
        tenantId: 'tenant-001',
        roleCodes: [],
        scopes: ['erp:recruitment:channel:ingest'],
        departmentIds: [],
        traceId: 'trace-channel-service',
      },
    }, () => allowed.service.requestAnalysisFromTrustedEvidence(
      'trusted-evidence-allowed', CANDIDATE_ID, 'resume-evidence-001',
    ))).resolves.toMatchObject({ analysis: { id: ANALYSIS_ID } });
  });

  it('读取与列表始终绑定可信租户并返回受控标签体系', async () => {
    const invalidId = serviceFixture();
    await expect(trusted(invalidId.context, () => invalidId.service.getAnalysis('invalid')))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    const get = serviceFixture();
    get.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({ status: 'approved' })));
    await expect(trusted(get.context, () => get.service.getAnalysis(ANALYSIS_ID)))
      .resolves.toMatchObject({ id: ANALYSIS_ID, candidateName: '候选人甲' });
    expect(get.analyses.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: ANALYSIS_ID,
    });

    const missing = serviceFixture();
    await expect(trusted(missing.context, () => missing.service.getAnalysis(ANALYSIS_ID)))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_ANALYSIS_NOT_FOUND' } });
    await expect(trusted(missing.context, () => missing.service.getAnalysis('invalid')))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    const list = serviceFixture();
    list.analyses.find.mockReturnValueOnce(listQueryResult([
      analysisRecord({
        status: 'approved',
        tags: [{
          category: 'role_family',
          code: 'role_engineering',
          label: '研发',
          confidence: 1,
          evidence: '人工确认',
          source: 'manual',
          status: 'confirmed',
        }],
      }),
    ]));
    const listed = await trusted(list.context, () => list.service.listAnalyses({
      status: 'approved',
      tag: 'role_engineering',
      limit: 10,
    }));
    expect(listed.items).toHaveLength(1);
    expect(listed.taxonomy.length).toBeGreaterThan(0);
    expect(list.analyses.find).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      status: 'approved',
      tags: { $elemMatch: { code: 'role_engineering', status: 'confirmed' } },
    });

    const invalidTag = serviceFixture();
    await expect(trusted(invalidTag.context, () => invalidTag.service.listAnalyses({
      tag: 'unknown_tag',
      limit: 50,
    }))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });
  });

  it('人工复核校验版本、状态、受控决策并原子写事件', async () => {
    const existingTag = {
      category: 'role_family',
      code: 'role_engineering',
      label: '研发',
      confidence: 0.9,
      evidence: '研发经历',
      source: 'ai',
      status: 'suggested',
    };
    const base = analysisRecord({
      status: 'review_required',
      version: 3,
      tags: [existingTag],
    });
    const invalidInput = serviceFixture();
    await expect(trusted(invalidInput.context, () => invalidInput.service.review(
      'review-invalid-input',
      ANALYSIS_ID,
      3,
      {
        decisions: [
          { code: 'role_engineering', status: 'confirmed' },
          { code: 'role_engineering', status: 'rejected' },
        ],
        manualTagCodes: [],
      },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    const missing = serviceFixture();
    await expect(trusted(missing.context, () => missing.service.review(
      'review-missing', ANALYSIS_ID, 3, { decisions: [], manualTagCodes: [] },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_ANALYSIS_NOT_FOUND' } });

    const version = serviceFixture();
    version.analyses.findOne.mockReturnValueOnce(queryResult(base));
    await expect(trusted(version.context, () => version.service.review(
      'review-version', ANALYSIS_ID, 2, { decisions: [], manualTagCodes: [] },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_VERSION_CONFLICT' } });

    const notReady = serviceFixture();
    notReady.analyses.findOne.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'processing',
      version: 3,
    })));
    await expect(trusted(notReady.context, () => notReady.service.review(
      'review-not-ready', ANALYSIS_ID, 3, { decisions: [], manualTagCodes: [] },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_REVIEW_NOT_READY' } });

    const unknownDecision = serviceFixture();
    unknownDecision.analyses.findOne.mockReturnValueOnce(queryResult(base));
    await expect(trusted(unknownDecision.context, () => unknownDecision.service.review(
      'review-unknown-decision',
      ANALYSIS_ID,
      3,
      {
        decisions: [{ code: 'level_senior', status: 'confirmed' }],
        manualTagCodes: [],
      },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_INPUT_INVALID' } });

    const conflict = serviceFixture();
    conflict.analyses.findOne.mockReturnValueOnce(queryResult(base));
    await expect(trusted(conflict.context, () => conflict.service.review(
      'review-update-conflict',
      ANALYSIS_ID,
      3,
      { decisions: [], manualTagCodes: [] },
    ))).rejects.toMatchObject({ response: { code: 'RECRUITMENT_RESUME_VERSION_CONFLICT' } });

    const success = serviceFixture();
    success.analyses.findOne.mockReturnValueOnce(queryResult(base));
    const approved = analysisRecord({
      ...base,
      status: 'approved',
      version: 4,
      tags: [
        { ...existingTag, status: 'confirmed' },
        {
          category: 'seniority',
          code: 'level_senior',
          label: '高级',
          confidence: 1,
          evidence: '招聘人员人工确认',
          source: 'manual',
          status: 'confirmed',
        },
      ],
    });
    success.analyses.findOneAndUpdate.mockReturnValueOnce(queryResult(approved));
    const result = await trusted(success.context, () => success.service.review(
      'review-success',
      ANALYSIS_ID,
      3,
      {
        decisions: [{ code: 'role_engineering', status: 'confirmed' }],
        manualTagCodes: ['role_engineering', 'level_senior'],
      },
    ));
    expect(result.analysis).toMatchObject({ status: 'approved', version: 4 });
    expect(success.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.resume_analysis.reviewed',
    }), {});
  });

  it('Worker 对未认领、AI 非法标签和租约丢失采用确定性终态', async () => {
    const notClaimed = serviceFixture();
    await expect(workerTrusted(notClaimed.context, () => notClaimed.service.processAnalysis(
      ANALYSIS_ID,
    ))).resolves.toBeNull();
    expect(notClaimed.source.readRedactedText).not.toHaveBeenCalled();

    const invalidTag = serviceFixture();
    const claimed = analysisRecord({
      status: 'processing',
      version: 2,
      attempts: 1,
      processingStartedAt: new Date(),
    });
    invalidTag.analyses.findOneAndUpdate.mockReturnValueOnce(queryResult(claimed));
    invalidTag.ai.analyze.mockResolvedValueOnce({
      model: 'gpt-test',
      headline: '研发',
      summary: '经验',
      yearsExperience: 5,
      educationLevel: 'bachelor',
      skills: [],
      jobTitles: [],
      industries: [],
      languages: [],
      tags: [{ code: 'unknown_tag', confidence: 0.9, evidence: '非法标签' }],
    });
    await expect(workerTrusted(invalidTag.context, () => invalidTag.service.processAnalysis(
      ANALYSIS_ID,
    ))).rejects.toThrow('RECRUITMENT_RESUME_AI_TAG_INVALID');
    const invalidTagFailureFields: unknown = expect.objectContaining({
      status: 'failed',
      failureCode: 'RECRUITMENT_RESUME_AI_TAG_INVALID',
    });
    expect(invalidTag.analyses.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', id: ANALYSIS_ID, version: 2 }),
      expect.objectContaining({
        $set: invalidTagFailureFields,
      }),
      { runValidators: true, timestamps: false },
    );

    const leaseLost = serviceFixture();
    leaseLost.analyses.findOneAndUpdate
      .mockReturnValueOnce(queryResult(claimed))
      .mockReturnValueOnce(queryResult(null));
    await expect(workerTrusted(leaseLost.context, () => leaseLost.service.processAnalysis(
      ANALYSIS_ID,
    ))).rejects.toThrow('RECRUITMENT_RESUME_PROCESSING_LEASE_LOST');
    expect(leaseLost.analyses.updateOne).toHaveBeenCalled();

    const failureLeaseLost = serviceFixture();
    failureLeaseLost.analyses.findOneAndUpdate.mockReturnValueOnce(queryResult(claimed));
    failureLeaseLost.source.readRedactedText.mockRejectedValueOnce(new Error('source failed'));
    failureLeaseLost.analyses.updateOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    });
    await expect(workerTrusted(
      failureLeaseLost.context,
      () => failureLeaseLost.service.processAnalysis(ANALYSIS_ID),
    )).rejects.toThrow('RECRUITMENT_RESUME_PROCESSING_LEASE_LOST');
  });

  it('Worker 将非稳定上游异常归一化为处理失败码', async () => {
    const failure = serviceFixture();
    failure.analyses.findOneAndUpdate.mockReturnValueOnce(queryResult(analysisRecord({
      status: 'processing',
      version: 2,
      attempts: 1,
      processingStartedAt: new Date(),
    })));
    failure.source.readRedactedText.mockRejectedValueOnce(new Error('upstream timeout'));
    await expect(workerTrusted(failure.context, () => failure.service.processAnalysis(
      ANALYSIS_ID,
    ))).rejects.toThrow('upstream timeout');
    const upstreamFailureFields: unknown = expect.objectContaining({
      failureCode: 'RECRUITMENT_RESUME_PROCESSING_FAILED',
    });
    expect(failure.analyses.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: upstreamFailureFields,
      }),
      { runValidators: true, timestamps: false },
    );
  });
});

function candidateRepository(): RecruitmentCandidateRepository {
  return {
    findById: vi.fn().mockResolvedValue(candidateRecord()),
  } as unknown as RecruitmentCandidateRepository;
}

function candidateRecord() {
  return {
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
  };
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
