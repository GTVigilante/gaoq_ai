import { describe, expect, it } from 'vitest';

import { createRecruitmentResumeAnalysisJobId } from './recruitment-resume.queue.js';

describe('createRecruitmentResumeAnalysisJobId', () => {
  it('同一租户与分析生成确定、不可解释且 BullMQ 安全的作业 ID', () => {
    const first = createRecruitmentResumeAnalysisJobId('tenant-001', 'analysis-001');
    const second = createRecruitmentResumeAnalysisJobId('tenant-001', 'analysis-001');

    expect(first).toBe(second);
    expect(first).toMatch(/^recruitment_resume_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain('tenant-001');
    expect(first).not.toContain('analysis-001');
  });

  it('租户或分析变化时作业 ID 都变化，避免跨租户去重碰撞', () => {
    const original = createRecruitmentResumeAnalysisJobId('tenant-001', 'analysis-001');
    expect(createRecruitmentResumeAnalysisJobId('tenant-002', 'analysis-001'))
      .not.toBe(original);
    expect(createRecruitmentResumeAnalysisJobId('tenant-001', 'analysis-002'))
      .not.toBe(original);
  });
});
