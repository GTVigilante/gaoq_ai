import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { KnowledgeSearchIndexProcessor } from './knowledge-search-index.processor.js';
import { KNOWLEDGE_SEARCH_INDEX_SCAN_JOB } from './knowledge-search-index.queue.js';

describe('Knowledge 搜索索引 Worker', () => {
  it('仅接受固定空载荷扫描任务', async () => {
    const relay = { relayBatch: vi.fn().mockResolvedValue(0) };
    const processor = new KnowledgeSearchIndexProcessor(relay as never);

    await expect(processor.process({
      id: 'job-001',
      name: KNOWLEDGE_SEARCH_INDEX_SCAN_JOB,
      data: {},
    } as Job)).resolves.toBeUndefined();
    expect(relay.relayBatch).toHaveBeenCalledOnce();

    await expect(processor.process({
      id: 'job-002',
      name: 'rebuild:index',
      data: {},
    } as Job)).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_JOB_UNKNOWN');
    await expect(processor.process({
      id: 'job-003',
      name: KNOWLEDGE_SEARCH_INDEX_SCAN_JOB,
      data: { tenantId: 'tenant-from-client' },
    } as Job)).rejects.toThrow();
    expect(relay.relayBatch).toHaveBeenCalledOnce();
  });
});
