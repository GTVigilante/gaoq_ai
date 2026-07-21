import { describe, expect, it } from 'vitest';

import { buildPhaseThreeKnowledgeIndexManifest } from './phase-3-knowledge-indexes.js';

describe('Phase 3 Knowledge 索引追加迁移', () => {
  it('覆盖课程、任务、考试、进度证据与入职证明集合', () => {
    const collections = new Set(
      buildPhaseThreeKnowledgeIndexManifest().map((item) => item.collection),
    );
    expect(collections).toEqual(new Set([
      'knowledge_course_versions', 'knowledge_training_assignments',
      'knowledge_exam_attempts', 'knowledge_progress_events',
      'knowledge_onboarding_attestations',
    ]));
  });

  it('包含业务幂等和不可变证明唯一约束', () => {
    const manifest = buildPhaseThreeKnowledgeIndexManifest();
    for (const [collection, field] of [
      ['knowledge_exam_attempts', 'submissionRef'],
      ['knowledge_progress_events', 'sourceEventId'],
      ['knowledge_onboarding_attestations', 'onboardingInstanceId'],
    ] as const) {
      expect(manifest.some((item) =>
        item.collection === collection && item.key[field] === 1 && item.options.unique === true,
      )).toBe(true);
    }
  });
});
