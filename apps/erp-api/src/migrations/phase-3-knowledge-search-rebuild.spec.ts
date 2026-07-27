import { describe, expect, it, vi } from 'vitest';

import { runKnowledgeSearchRebuild } from './phase-3-knowledge-search-rebuild.js';

const published = {
  id: 'course-version-001',
  tenantId: 'tenant-001',
  courseCode: 'SECURITY',
  revision: 1,
  version: 2,
  contentRef: 'content-001',
  status: 'published' as const,
  updatedAt: new Date('2026-07-27T00:00:00.000Z'),
};

describe('Phase 3 Knowledge 搜索任务重建', () => {
  it('dry-run 只统计历史默认授权和待建任务，不写数据库', async () => {
    const store = fixture([published]);
    await expect(runKnowledgeSearchRebuild(
      store.connection as never,
      'dry-run',
    )).resolves.toEqual({
      scanned: 1,
      legacyAudienceBackfills: 1,
      tasksPrepared: 1,
      forceReplayRequested: false,
    });
    expect(store.courses.bulkWrite).not.toHaveBeenCalled();
    expect(store.tasks.bulkWrite).not.toHaveBeenCalled();
  });

  it('apply 以稳定业务键追加任务并回填默认拒绝授权', async () => {
    const store = fixture([published]);
    await runKnowledgeSearchRebuild(store.connection as never, 'apply');
    const courseOperations = store.courses.bulkWrite.mock.calls[0]?.[0] as
      readonly Record<string, unknown>[] | undefined;
    expect(courseOperations).toHaveLength(1);
    expect(JSON.stringify(courseOperations)).toContain('assigned_only');
    const taskOperations = store.tasks.bulkWrite.mock.calls[0]?.[0] as
      readonly {
        readonly updateOne?: {
          readonly filter?: Readonly<Record<string, unknown>>;
          readonly update?: { readonly $setOnInsert?: Readonly<Record<string, unknown>> };
          readonly upsert?: boolean;
        };
      }[] | undefined;
    expect(taskOperations).toHaveLength(1);
    expect(taskOperations?.[0]?.updateOne).toMatchObject({
      filter: {
        tenantId: 'tenant-001',
        courseVersionId: 'course-version-001',
        courseVersion: 2,
        operation: 'upsert',
      },
      upsert: true,
    });
    expect(taskOperations?.[0]?.updateOne?.update?.$setOnInsert).toMatchObject({
      audienceMode: 'assigned_only',
      audienceDepartmentIds: [],
      audiencePositionIds: [],
      status: 'pending',
    });
  });

  it('force-replay 显式清除旧回执并重新排队', async () => {
    const store = fixture([{
      ...published,
      audienceMode: 'employment_scope' as const,
      audienceDepartmentIds: ['department-001'],
      audiencePositionIds: [],
    }]);
    await runKnowledgeSearchRebuild(store.connection as never, 'force-replay');
    const operations = store.tasks.bulkWrite.mock.calls[0]?.[0] as
      readonly Record<string, unknown>[] | undefined;
    expect(operations).toHaveLength(2);
    expect(JSON.stringify(operations?.[1])).toContain('"status":"pending"');
    expect(JSON.stringify(operations?.[1])).toContain('"receiptId":null');
  });

  it('每门课程仅重建最高已发布修订，旧修订与下架版本生成删除任务', async () => {
    const store = fixture([
      {
        ...published,
        id: 'course-version-003',
        revision: 3,
        version: 4,
        status: 'retired' as const,
      },
      {
        ...published,
        id: 'course-version-002',
        revision: 2,
        version: 2,
        audienceMode: 'assigned_only' as const,
        audienceDepartmentIds: [],
        audiencePositionIds: [],
      },
      {
        ...published,
        id: 'course-version-001',
        revision: 1,
        version: 2,
        audienceMode: 'assigned_only' as const,
        audienceDepartmentIds: [],
        audiencePositionIds: [],
      },
    ]);

    await runKnowledgeSearchRebuild(store.connection as never, 'apply');

    const operations = store.tasks.bulkWrite.mock.calls[0]?.[0] as
      readonly {
        readonly updateOne?: {
          readonly filter?: Readonly<Record<string, unknown>>;
        };
      }[] | undefined;
    expect(operations?.map((item) => item.updateOne?.filter?.['operation'])).toEqual([
      'delete',
      'upsert',
      'delete',
    ]);
  });

  it('非法历史授权组合失败关闭且不产生任务', async () => {
    const store = fixture([{
      ...published,
      audienceMode: 'employment_scope' as const,
      audienceDepartmentIds: [],
      audiencePositionIds: [],
    }]);
    await expect(runKnowledgeSearchRebuild(
      store.connection as never,
      'dry-run',
    )).rejects.toThrow('KNOWLEDGE_SEARCH_REBUILD_AUDIENCE_INVALID');
    expect(store.tasks.bulkWrite).not.toHaveBeenCalled();
  });
});

function fixture(records: readonly Record<string, unknown>[]) {
  const cursor = {
    sort: vi.fn().mockReturnThis(),
    batchSize: vi.fn().mockReturnThis(),
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      for (const record of records) yield record;
    },
  };
  const courses = {
    find: vi.fn().mockReturnValue(cursor),
    bulkWrite: vi.fn().mockResolvedValue({}),
  };
  const tasks = {
    bulkWrite: vi.fn().mockResolvedValue({}),
  };
  return {
    courses,
    tasks,
    connection: {
      collection: vi.fn((name: string) =>
        name === 'knowledge_course_versions' ? courses : tasks),
    },
  };
}
