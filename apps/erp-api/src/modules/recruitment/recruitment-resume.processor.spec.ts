import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type {
  RecruitmentResumeAnalysisView,
  RecruitmentResumeService,
} from './application/recruitment-resume.service.js';
import { RecruitmentResumeProcessor } from './recruitment-resume.processor.js';
import {
  RECRUITMENT_RESUME_ANALYZE_JOB,
  createRecruitmentResumeAnalysisJobId,
  type RecruitmentResumeAnalysisJobData,
} from './recruitment-resume.queue.js';

const TENANT_ID = 'tenant-001';
const ANALYSIS_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E2';

describe('RecruitmentResumeProcessor', () => {
  it('在可信 system_job 租户上下文中处理并记录成功审计', async () => {
    const fixture = processorFixture();
    fixture.resumes.processAnalysis.mockImplementation(() => {
      expect(fixture.context.getActorRequired()).toMatchObject({
        actorType: 'system_job',
        tenantId: TENANT_ID,
        scopes: ['erp:recruitment:resume:process'],
      });
      return Promise.resolve(analysisView());
    });

    await fixture.processor.process(job());

    expect(fixture.resumes.processAnalysis).toHaveBeenCalledWith(ANALYSIS_ID);
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.resume.analysis.complete',
      resourceId: ANALYSIS_ID,
      outcome: 'success',
      metadata: {
        candidateId: 'candidate-001',
        suggestedTagCount: 1,
        model: 'gpt-test',
      },
    }));
  });

  it('无可认领分析时安全跳过且不写审计', async () => {
    const fixture = processorFixture();
    fixture.resumes.processAnalysis.mockResolvedValue(null);
    await fixture.processor.process(job());
    expect(fixture.audit.record).not.toHaveBeenCalled();
  });

  it('稳定错误码写入失败审计并保留原错误供 BullMQ 重试', async () => {
    const fixture = processorFixture();
    const failure = new Error('RECRUITMENT_RESUME_AI_REQUEST_FAILED');
    fixture.resumes.processAnalysis.mockRejectedValue(failure);

    await expect(fixture.processor.process(job())).rejects.toBe(failure);
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { failureCode: 'RECRUITMENT_RESUME_AI_REQUEST_FAILED' },
    }));
  });

  it('未知异常只审计通用错误码且审计故障不吞掉业务异常', async () => {
    const fixture = processorFixture();
    const failure = { secret: '不得进入审计' };
    fixture.resumes.processAnalysis.mockRejectedValue(failure);
    fixture.audit.record.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));

    await expect(fixture.processor.process(job())).rejects.toBe(failure);
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { failureCode: 'RECRUITMENT_RESUME_PROCESSING_FAILED' },
    }));
  });

  it('成功终态后的审计故障不会触发模型重放', async () => {
    const fixture = processorFixture();
    fixture.audit.record.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));
    await expect(fixture.processor.process(job())).resolves.toBeUndefined();
    expect(fixture.resumes.processAnalysis).toHaveBeenCalledTimes(1);
    expect(fixture.audit.record).toHaveBeenCalledTimes(1);
  });

  it('拒绝未知作业名、畸形载荷和不匹配的确定性作业 ID', async () => {
    const unknown = processorFixture();
    await expect(unknown.processor.process(job({ name: 'unknown' })))
      .rejects.toThrow('RECRUITMENT_RESUME_JOB_UNKNOWN');

    const malformed = processorFixture();
    await expect(malformed.processor.process(job({
      data: { tenantId: TENANT_ID, analysisId: 'invalid' },
    }))).rejects.toMatchObject({ name: 'ZodError' });

    const mismatch = processorFixture();
    await expect(mismatch.processor.process(job({ id: 'wrong-job-id' })))
      .rejects.toThrow('RECRUITMENT_RESUME_JOB_ID_MISMATCH');

    expect(unknown.resumes.processAnalysis).not.toHaveBeenCalled();
    expect(malformed.resumes.processAnalysis).not.toHaveBeenCalled();
    expect(mismatch.resumes.processAnalysis).not.toHaveBeenCalled();
  });

  it('成功审计在没有模型名时不生成 model 字段', async () => {
    const fixture = processorFixture();
    fixture.resumes.processAnalysis.mockResolvedValue({
      ...analysisView(),
      aiModel: null,
    });
    await fixture.processor.process(job());
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        candidateId: 'candidate-001',
        suggestedTagCount: 1,
      },
    }));
    const auditInput = fixture.audit.record.mock.calls[0]?.[0] as unknown as {
      readonly metadata: Readonly<Record<string, unknown>>;
    };
    expect(auditInput.metadata).not.toHaveProperty('model');
  });
});

function processorFixture() {
  const context = new TenantContextService();
  const resumes = { processAnalysis: vi.fn().mockResolvedValue(analysisView()) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    context,
    resumes,
    audit,
    processor: new RecruitmentResumeProcessor(
      context,
      resumes as unknown as RecruitmentResumeService,
      audit as unknown as AuditService,
    ),
  };
}

function job(overrides: {
  readonly name?: string;
  readonly id?: string;
  readonly data?: RecruitmentResumeAnalysisJobData;
} = {}): Job<RecruitmentResumeAnalysisJobData> {
  const data = overrides.data ?? { tenantId: TENANT_ID, analysisId: ANALYSIS_ID };
  return {
    name: overrides.name ?? RECRUITMENT_RESUME_ANALYZE_JOB,
    id: overrides.id ?? createRecruitmentResumeAnalysisJobId(
      data.tenantId,
      data.analysisId,
    ),
    data,
  } as Job<RecruitmentResumeAnalysisJobData>;
}

function analysisView(): RecruitmentResumeAnalysisView {
  return {
    id: ANALYSIS_ID,
    candidateId: 'candidate-001',
    candidateName: null,
    resumeEvidenceId: 'evidence-001',
    status: 'review_required',
    profile: null,
    tags: [{
      category: 'role_family',
      code: 'role_engineering',
      label: '研发',
      confidence: 0.9,
      evidence: '研发经历',
      source: 'ai',
      status: 'suggested',
    }],
    aiModel: 'gpt-test',
    failureCode: null,
    attempts: 1,
    version: 3,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
