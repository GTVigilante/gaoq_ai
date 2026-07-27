import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  KnowledgeSearchIndexTaskRecordSchema,
  type KnowledgeSearchIndexTaskRecord,
} from './knowledge-search.schemas.js';

const mongoose = new Mongoose();
const TaskModel = mongoose.model<KnowledgeSearchIndexTaskRecord>(
  'SpecKnowledgeSearchIndexTask',
  KnowledgeSearchIndexTaskRecordSchema,
);

const base = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
  tenantId: 'tenant-001',
  courseVersionId: 'course-version-001',
  courseCode: 'SECURITY',
  revision: 1,
  courseVersion: 2,
  contentRef: 'content-001',
  operation: 'upsert',
  audienceMode: 'assigned_only',
  audienceDepartmentIds: [],
  audiencePositionIds: [],
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date('2026-07-27T00:00:00.000Z'),
  lockedAt: null,
  lockedBy: null,
  completedAt: null,
  receiptId: null,
  indexedContentDigest: null,
  indexedAt: null,
  lastErrorCode: null,
} as const;

describe('Knowledge 搜索索引任务持久化契约', () => {
  it('完成任务必须持有完整回执证据，非完成任务必须全部为空', async () => {
    await expect(new TaskModel(base).validate()).resolves.toBeUndefined();
    await expect(new TaskModel({
      ...base,
      receiptId: 'receipt-001',
    }).validate()).rejects.toThrow(/完成证据组合非法/);
    await expect(new TaskModel({
      ...base,
      status: 'completed',
      completedAt: new Date('2026-07-27T00:00:01.000Z'),
      receiptId: 'receipt-001',
      indexedContentDigest: 'a'.repeat(43),
      indexedAt: new Date('2026-07-27T00:00:01.000Z'),
    }).validate()).resolves.toBeUndefined();
  });

  it('只有 processing 可持有完整锁，任职受众必须满足组合约束', async () => {
    await expect(new TaskModel({
      ...base,
      status: 'processing',
      lockedAt: new Date('2026-07-27T00:00:00.000Z'),
      lockedBy: 'worker-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new TaskModel({
      ...base,
      lockedBy: 'worker-001',
    }).validate()).rejects.toThrow(/锁组合非法/);
    await expect(new TaskModel({
      ...base,
      audienceMode: 'employment_scope',
    }).validate()).rejects.toThrow(/授权组合非法/);
  });

  it('事件键与课程版本操作均有租户内唯一约束', () => {
    expect(KnowledgeSearchIndexTaskRecordSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ tenantId: 1, eventId: 1 }, expect.objectContaining({ unique: true })],
        [
          { tenantId: 1, courseVersionId: 1, courseVersion: 1, operation: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });
});
