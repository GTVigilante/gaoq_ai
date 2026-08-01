import { describe, expect, it } from 'vitest';

import { buildPhaseThreeKnowledgeExamIndexManifest } from './phase-3-knowledge-exam-indexes.js';

describe('Phase 3 Knowledge 考试编排索引追加迁移', () => {
  it('只追加考试运行与最终尝试集合索引且包含活跃运行唯一约束', () => {
    const manifest = buildPhaseThreeKnowledgeExamIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(
      new Set(['knowledge_exam_runs', 'knowledge_exam_attempts']),
    );
    expect(manifest.some((item) =>
      item.key.tenantId === 1 &&
      item.key.assignmentId === 1 &&
      item.options.unique === true &&
      item.options.partialFilterExpression !== undefined,
    )).toBe(true);
  });

  it('为人工复核证据追加租户内唯一索引', () => {
    expect(buildPhaseThreeKnowledgeExamIndexManifest().some((item) =>
      item.collection === 'knowledge_exam_attempts' &&
      item.key.tenantId === 1 &&
      item.key.manualReviewEvidenceId === 1 &&
      item.options.unique === true &&
      item.options.partialFilterExpression !== undefined,
    )).toBe(true);
  });

  it('包含状态、下次动作时间和锁的可靠扫描索引', () => {
    expect(buildPhaseThreeKnowledgeExamIndexManifest().some((item) =>
      item.key.status === 1 &&
      item.key.nextActionAt === 1 &&
      item.key.lockedAt === 1,
    )).toBe(true);
  });
});
