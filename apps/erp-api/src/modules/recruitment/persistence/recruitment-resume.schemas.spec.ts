import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  RecruitmentResumeAnalysisRecordSchema,
  type RecruitmentResumeAnalysisRecord,
} from './recruitment-resume.schemas.js';

const mongoose = new Mongoose();
const ResumeAnalysisModel = mongoose.model<RecruitmentResumeAnalysisRecord>(
  'SpecRecruitmentResumeAnalysis',
  RecruitmentResumeAnalysisRecordSchema,
);

function record(): Record<string, unknown> {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E2',
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
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
  };
}

describe('RecruitmentResumeAnalysisRecordSchema', () => {
  it('集合不定义原始简历、提取正文、姓名或联系方式字段', async () => {
    await new ResumeAnalysisModel(record()).validate();
    for (const field of [
      'resume', 'resumeText', 'rawText', 'extractedText', 'candidateName', 'phone', 'email',
    ]) expect(RecruitmentResumeAnalysisRecordSchema.path(field)).toBeUndefined();
    expect(RecruitmentResumeAnalysisRecordSchema.path('sourceChecksum')).toBeDefined();
  });

  it('待复核状态必须包含完整结构结果，确认状态必须绑定复核人', async () => {
    await expect(new ResumeAnalysisModel({
      ...record(),
      status: 'review_required',
    }).validate()).rejects.toThrow('必须包含完整结构化结果');
    const analyzed = {
      ...record(),
      status: 'review_required',
      profile: {
        headline: '高级后端研发',
        summary: '企业级后端研发经历',
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
      analyzedAt: new Date(),
    };
    await new ResumeAnalysisModel(analyzed).validate();
    await expect(new ResumeAnalysisModel({
      ...analyzed,
      status: 'approved',
    }).validate()).rejects.toThrow('必须记录复核人和时间');
  });
});
