import { describe, expect, it } from 'vitest';

import { buildPhaseFiveAnalyticsIndexManifest } from './phase-5-analytics-indexes.js';

describe('Phase 5 管理分析索引迁移', () => {
  it('为审批、招聘申请和必修培训生成追加式查询索引', () => {
    const serialized = JSON.stringify(buildPhaseFiveAnalyticsIndexManifest());
    expect(serialized).toContain('approval_instances');
    expect(serialized).toContain('recruitment_applications');
    expect(serialized).toContain('knowledge_training_assignments');
    expect(serialized).toContain('analytics_management_exports');
    expect(serialized).toContain('completedAt');
    expect(serialized).toContain('endedAt');
    expect(serialized).toContain('mandatory');
    expect(serialized).toContain('expiresAt');
    expect(serialized).toContain('processingStartedAt');
  });
});
