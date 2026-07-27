import { describe, expect, it, vi } from 'vitest';

import { KnowledgeSearchIndexRelayService } from './knowledge-search-index-relay.service.js';

const task = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
  tenantId: 'tenant-001',
  courseVersionId: 'course-version-001',
  courseCode: 'SECURITY',
  revision: 1,
  courseVersion: 2,
  contentRef: 'content-001',
  operation: 'upsert' as const,
  audienceMode: 'employment_scope' as const,
  audienceDepartmentIds: ['department-001'],
  audiencePositionIds: ['position-001'],
  attempts: 0,
  createdAt: new Date('2026-07-27T00:00:00.000Z'),
};

describe('Knowledge 搜索索引事务任务 Relay', () => {
  it('使用事件标识幂等调用网关并原子保存签名回执摘要', async () => {
    const records = modelReturning(task);
    const index = { apply: vi.fn().mockResolvedValue({
      receiptId: 'receipt-001',
      indexedContentDigest: 'a'.repeat(43),
      indexedAt: '2026-07-27T00:00:00.000Z',
    }) };
    const metrics = { recordKnowledgeSearchIndex: vi.fn() };
    const relay = new KnowledgeSearchIndexRelayService(
      records as never,
      index,
      metrics as never,
    );

    await expect(relay.relayBatch('worker-001')).resolves.toBe(1);
    expect(index.apply).toHaveBeenCalledWith({
      eventId: task.eventId,
      tenantId: task.tenantId,
      courseVersionId: task.courseVersionId,
      courseCode: task.courseCode,
      revision: task.revision,
      courseVersion: task.courseVersion,
      contentRef: task.contentRef,
      operation: task.operation,
      audienceMode: task.audienceMode,
      audienceDepartmentIds: task.audienceDepartmentIds,
      audiencePositionIds: task.audiencePositionIds,
    });
    expect(JSON.stringify(index.apply.mock.calls)).not.toMatch(
      /authorization|bearer|token|正文|答案/iu,
    );
    const completed = records.updateOne.mock.calls[0]?.[1] as {
      readonly $set?: Readonly<Record<string, unknown>>;
    } | undefined;
    expect(completed?.$set).toMatchObject({
      status: 'completed',
      receiptId: 'receipt-001',
      indexedContentDigest: 'a'.repeat(43),
      lockedBy: null,
      lastErrorCode: null,
    });
    expect(metrics.recordKnowledgeSearchIndex).toHaveBeenCalledWith(
      'upsert',
      'success',
      0,
      new Date('2026-07-27T00:00:00.000Z'),
    );
  });

  it('瞬时失败释放锁并指数退避，达到上限进入可对账死信', async () => {
    const pending = modelReturning(task);
    const relay = new KnowledgeSearchIndexRelayService(
      pending as never,
      { apply: vi.fn().mockRejectedValue(new Error('network details')) },
      { recordKnowledgeSearchIndex: vi.fn() } as never,
    );
    await expect(relay.relayBatch('worker-001')).resolves.toBe(0);
    expect(lastUpdate(pending)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lockedBy: null,
      lastErrorCode: 'KNOWLEDGE_SEARCH_INDEX_FAILED',
    });

    const exhausted = modelReturning({ ...task, attempts: 7 });
    const deadRelay = new KnowledgeSearchIndexRelayService(
      exhausted as never,
      { apply: vi.fn().mockRejectedValue(
        new Error('KNOWLEDGE_SEARCH_GATEWAY_UNAVAILABLE'),
      ) },
      { recordKnowledgeSearchIndex: vi.fn() } as never,
    );
    await expect(deadRelay.relayBatch('worker-002')).resolves.toBe(0);
    expect(lastUpdate(exhausted)).toMatchObject({
      status: 'dead',
      attempts: 8,
      lockedBy: null,
      lastErrorCode: 'KNOWLEDGE_SEARCH_GATEWAY_UNAVAILABLE',
    });
  });

  it('外部调用成功后认领丢失时不得静默完成或篡改其他 Worker 状态', async () => {
    const records = modelReturning(task);
    records.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const index = { apply: vi.fn().mockResolvedValue({
      receiptId: 'receipt-001',
      indexedContentDigest: 'a'.repeat(43),
      indexedAt: '2026-07-27T00:00:00.000Z',
    }) };
    const relay = new KnowledgeSearchIndexRelayService(
      records as never,
      index,
      { recordKnowledgeSearchIndex: vi.fn() } as never,
    );

    await expect(relay.relayBatch('worker-001')).rejects.toThrow(
      'KNOWLEDGE_SEARCH_INDEX_CLAIM_LOST',
    );
    expect(index.apply).toHaveBeenCalledOnce();
    expect(records.updateOne).toHaveBeenCalledTimes(2);
  });
});

function modelReturning(value: typeof task | (typeof task & { readonly attempts: number })) {
  return {
    findOneAndUpdate: vi.fn()
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(value) })
      .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
}

function lastUpdate(records: ReturnType<typeof modelReturning>): Readonly<Record<string, unknown>> {
  const update = records.updateOne.mock.calls.at(-1)?.[1] as {
    readonly $set?: Readonly<Record<string, unknown>>;
  } | undefined;
  return update?.$set ?? {};
}
