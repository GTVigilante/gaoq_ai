import { createHash } from 'node:crypto';

export const RECRUITMENT_RESUME_QUEUE = 'recruitment-resume-analysis';
export const RECRUITMENT_RESUME_ANALYZE_JOB = 'analyze:recruitment:resume';

export interface RecruitmentResumeAnalysisJobData {
  readonly tenantId: string;
  readonly analysisId: string;
}

/** 任务标识绑定租户和分析记录，禁止替换载荷或跨租户复用同一 BullMQ Job。 */
export function createRecruitmentResumeAnalysisJobId(
  tenantId: string,
  analysisId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['recruitment-resume', tenantId, analysisId]), 'utf8')
    .digest('base64url');
  return `recruitment_resume_${digest}`;
}
