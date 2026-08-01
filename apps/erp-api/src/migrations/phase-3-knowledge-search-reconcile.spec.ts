import { describe, expect, it, vi } from 'vitest';

import {
  buildKnowledgeSearchReconciliationPipeline,
  runKnowledgeSearchReconciliation,
} from './phase-3-knowledge-search-reconcile.js';

describe('Phase 3 Knowledge 搜索索引对账', () => {
  it('只按稳定业务键和回执状态聚合，不读取正文或人员明细', () => {
    const pipeline = JSON.stringify(buildKnowledgeSearchReconciliationPipeline());
    expect(pipeline).toContain('knowledge_search_index_tasks');
    expect(pipeline).toContain('expectedOperation');
    expect(pipeline).toContain('indexedContentDigest');
    expect(pipeline).not.toMatch(/contentRef|snippet|title|employee|department|position/iu);
  });

  it('仅当缺失、待处理、死信和过期回执均为零时通过', async () => {
    const ready = fixture([{
      expected: 3,
      completed: 3,
      missing: 0,
      pending: 0,
      dead: 0,
      stale: 0,
    }]);
    await expect(runKnowledgeSearchReconciliation(ready.connection as never))
      .resolves.toMatchObject({ ready: true, expected: 3, completed: 3 });

    const blocked = fixture([{
      expected: 3,
      completed: 1,
      missing: 1,
      pending: 0,
      dead: 1,
      stale: 0,
    }]);
    await expect(runKnowledgeSearchReconciliation(blocked.connection as never))
      .resolves.toMatchObject({ ready: false, missing: 1, dead: 1 });
  });
});

function fixture(rows: readonly Record<string, number>[]) {
  const toArray = vi.fn().mockResolvedValue(rows);
  const aggregate = vi.fn().mockReturnValue({ toArray });
  const collection = vi.fn().mockReturnValue({ aggregate });
  return {
    connection: { collection },
    aggregate,
  };
}
