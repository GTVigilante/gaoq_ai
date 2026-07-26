export const RECRUITMENT_RESUME_QUEUE = 'recruitment-resume-analysis';
export const RECRUITMENT_RESUME_ANALYZE_JOB = 'analyze:recruitment:resume';

export interface RecruitmentResumeAnalysisJobData {
  readonly tenantId: string;
  readonly analysisId: string;
}
