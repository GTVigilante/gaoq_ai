import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type {
  RecruitmentResumeAnalysisView,
  RecruitmentResumeService,
} from './application/recruitment-resume.service.js';
import { RecruitmentResumeController } from './recruitment-resume.controller.js';

const ANALYSIS_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E2';

describe('RecruitmentResumeController', () => {
  it('将分析、读取和人工复核拆分为三个最小 Scope', () => {
    expect(scope('request')).toEqual(['erp:recruitment:resume:analyze']);
    expect(scope('list')).toEqual(['erp:recruitment:resume:read']);
    expect(scope('get')).toEqual(['erp:recruitment:resume:read']);
    expect(scope('review')).toEqual(['erp:recruitment:resume:review']);
  });

  it('发起分析后设置强 ETag 并记录提交后审计', async () => {
    const fixture = controllerFixture();
    const result = await fixture.controller.request(
      'candidate-001',
      'request-key-001',
      { resumeEvidenceId: 'evidence-001' },
      fixture.response,
    );

    expect(result.analysis.id).toBe(ANALYSIS_ID);
    expect(fixture.resumes.requestAnalysis).toHaveBeenCalledWith(
      'request-key-001',
      'candidate-001',
      { resumeEvidenceId: 'evidence-001' },
    );
    expect(fixture.setHeader).toHaveBeenCalledWith('ETag', '"3"');
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.resume.analysis.request',
      resourceId: ANALYSIS_ID,
      outcome: 'success',
      metadata: {
        candidateId: 'candidate-001',
        status: 'review_required',
        version: 3,
      },
    }));
  });

  it.each([undefined, ''])('发起分析缺少幂等键时失败关闭：%s', async (key) => {
    const fixture = controllerFixture();
    await expect(fixture.controller.request(
      'candidate-001',
      key,
      { resumeEvidenceId: 'evidence-001' },
      fixture.response,
    )).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    expect(fixture.resumes.requestAnalysis).not.toHaveBeenCalled();
  });

  it('列表和详情只委托应用服务，详情返回版本 ETag', async () => {
    const fixture = controllerFixture();
    const query = { status: 'approved' as const, limit: 20 };
    expect(fixture.controller.list(query)).toEqual({ items: [], taxonomy: [] });
    expect(fixture.resumes.listAnalyses).toHaveBeenCalledWith(query);

    await expect(fixture.controller.get(ANALYSIS_ID, fixture.response))
      .resolves.toMatchObject({ id: ANALYSIS_ID });
    expect(fixture.resumes.getAnalysis).toHaveBeenCalledWith(ANALYSIS_ID);
    expect(fixture.setHeader).toHaveBeenCalledWith('ETag', '"3"');
  });

  it('人工复核解析强 If-Match、设置新 ETag 并审计确认标签数', async () => {
    const fixture = controllerFixture();
    await expect(fixture.controller.review(
      ANALYSIS_ID,
      '"3"',
      'review-key-001',
      { decisions: [], manualTagCodes: [] },
      fixture.response,
    )).resolves.toMatchObject({ analysis: { id: ANALYSIS_ID } });

    expect(fixture.resumes.review).toHaveBeenCalledWith(
      'review-key-001',
      ANALYSIS_ID,
      3,
      { decisions: [], manualTagCodes: [] },
    );
    expect(fixture.setHeader).toHaveBeenCalledWith('ETag', '"3"');
    expect(fixture.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.resume.analysis.review',
      metadata: { confirmedTagCount: 1, version: 3 },
    }));
  });

  it.each([
    undefined,
    '',
    '3',
    'W/"3"',
    '"0"',
    '"9007199254740992"',
  ])('人工复核拒绝无效 If-Match：%s', async (ifMatch) => {
    const fixture = controllerFixture();
    await expect(fixture.controller.review(
      ANALYSIS_ID,
      ifMatch,
      'review-key-001',
      { decisions: [], manualTagCodes: [] },
      fixture.response,
    )).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' },
    });
    expect(fixture.resumes.review).not.toHaveBeenCalled();
  });

  it('业务已成功后审计故障不会把接口结果改写为失败', async () => {
    const fixture = controllerFixture();
    fixture.audit.record.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));

    await expect(fixture.controller.request(
      'candidate-001',
      'request-key-001',
      { resumeEvidenceId: 'evidence-001' },
      fixture.response,
    )).resolves.toMatchObject({ analysis: { id: ANALYSIS_ID } });
    await expect(fixture.controller.review(
      ANALYSIS_ID,
      '"3"',
      'review-key-001',
      { decisions: [], manualTagCodes: [] },
      fixture.response,
    )).resolves.toMatchObject({ analysis: { id: ANALYSIS_ID } });
  });
});

function controllerFixture() {
  const analysis = analysisView();
  const resumes = {
    requestAnalysis: vi.fn().mockResolvedValue({ analysis }),
    listAnalyses: vi.fn().mockReturnValue({ items: [], taxonomy: [] }),
    getAnalysis: vi.fn().mockResolvedValue(analysis),
    review: vi.fn().mockResolvedValue({ analysis }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const setHeader = vi.fn();
  const response = { setHeader } as unknown as Response;
  return {
    controller: new RecruitmentResumeController(
      resumes as unknown as RecruitmentResumeService,
      audit as unknown as AuditService,
    ),
    resumes,
    audit,
    response,
    setHeader,
  };
}

function analysisView(): RecruitmentResumeAnalysisView {
  return {
    id: ANALYSIS_ID,
    candidateId: 'candidate-001',
    candidateName: '候选人甲',
    resumeEvidenceId: 'evidence-001',
    status: 'review_required',
    profile: null,
    tags: [
      {
        category: 'role_family',
        code: 'role_engineering',
        label: '研发',
        confidence: 1,
        evidence: '人工确认',
        source: 'manual',
        status: 'confirmed',
      },
      {
        category: 'industry',
        code: 'industry_software',
        label: '软件',
        confidence: 0.8,
        evidence: '模型建议',
        source: 'ai',
        status: 'suggested',
      },
    ],
    aiModel: 'gpt-test',
    failureCode: null,
    attempts: 1,
    version: 3,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

function scope(methodName: keyof RecruitmentResumeController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    RecruitmentResumeController.prototype,
    methodName,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method);
}
