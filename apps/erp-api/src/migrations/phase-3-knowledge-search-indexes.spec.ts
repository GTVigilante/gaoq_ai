import { describe, expect, it } from 'vitest';

import {
  buildPhaseThreeKnowledgeSearchIndexManifest,
} from './phase-3-knowledge-search-indexes.js';

describe('Phase 3 Knowledge 搜索追加索引迁移', () => {
  it('仅持有课程授权范围与搜索任务集合的新索引', () => {
    const manifest = buildPhaseThreeKnowledgeSearchIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'knowledge_course_versions',
      'knowledge_search_index_tasks',
    ]));
    expect(manifest.some((item) =>
      item.collection === 'knowledge_course_versions' &&
      item.key.audienceDepartmentIds === 1)).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'knowledge_course_versions' &&
      item.key.audiencePositionIds === 1)).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'knowledge_search_index_tasks' &&
      item.key.eventId === 1 &&
      item.options.unique === true)).toBe(true);
  });

  it('不改写已发布的 Knowledge v1 迁移标识或清单', () => {
    expect(JSON.stringify(buildPhaseThreeKnowledgeSearchIndexManifest()))
      .not.toContain('phase-3-knowledge-indexes-v1');
  });
});
