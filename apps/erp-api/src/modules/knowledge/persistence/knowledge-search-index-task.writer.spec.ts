import type { ClientSession, Model } from 'mongoose';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CourseVersion } from '../domain/index.js';
import type { KnowledgeSearchIndexTaskDocument } from './knowledge-search.schemas.js';
import { KnowledgeSearchIndexTaskWriter } from './knowledge-search-index-task.writer.js';

interface StoredTaskRow {
  readonly eventId: string;
  readonly tenantId: string;
  readonly courseVersionId: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly courseVersion: number;
  readonly contentRef: string;
  readonly operation: 'upsert' | 'delete';
  readonly audienceMode: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds: readonly string[];
  readonly audiencePositionIds: readonly string[];
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lockedAt: null;
  readonly lockedBy: null;
  readonly completedAt: null;
  readonly receiptId: null;
  readonly indexedContentDigest: null;
  readonly indexedAt: null;
  readonly lastErrorCode: null;
  readonly [key: string]: unknown;
}

type CreateTask = (
  rows: readonly StoredTaskRow[],
  options: { readonly session: ClientSession },
) => Promise<readonly unknown[]>;

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y0';
const TENANT_ID = 'tenant-001';
const UPDATED_AT = '2026-07-29T02:00:00.000Z';
const session = {
  inTransaction: vi.fn(() => true),
} as unknown as ClientSession;
const publishedCourse: CourseVersion = Object.freeze({
  id: 'course-version-001',
  tenantId: TENANT_ID,
  courseCode: 'SECURITY_101',
  revision: 2,
  title: '信息安全',
  contentRef: 'content-001',
  questionBankRef: null,
  questionBankDigest: null,
  passingScoreBps: null,
  questionMode: null,
  timeLimitMinutes: null,
  maxAttempts: null,
  gradingPolicyVersion: null,
  passingRule: null,
  gradingSlaMinutes: null,
  manualReviewSlaMinutes: null,
  manualReviewRequired: false,
  audienceMode: 'assigned_only',
  audienceDepartmentIds: Object.freeze([]),
  audiencePositionIds: Object.freeze([]),
  status: 'published',
  version: 2,
  createdAt: '2026-07-29T01:00:00.000Z',
  updatedAt: UPDATED_AT,
});
const employmentCourse: CourseVersion = Object.freeze({
  ...publishedCourse,
  audienceMode: 'employment_scope',
  audienceDepartmentIds: Object.freeze(['department-001', 'department-002']),
  audiencePositionIds: Object.freeze(['position-001']),
});
const retiredCourse: CourseVersion = Object.freeze({
  ...employmentCourse,
  status: 'retired',
  version: 3,
  updatedAt: '2026-07-29T03:00:00.000Z',
});

describe('KnowledgeSearchIndexTaskWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['upsert', publishedCourse],
    ['upsert', employmentCourse],
    ['delete', retiredCourse],
  ] as const)('在活动事务中写入规范 %s 任务', async (operation, course) => {
    const { writer, create } = setup();

    await writer.append(EVENT_ID, course, operation, session);

    expect(create).toHaveBeenCalledTimes(1);
    const [rows, options] = create.mock.calls[0]!;
    expect(options).toEqual({ session });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      courseVersionId: course.id,
      courseCode: course.courseCode,
      revision: course.revision,
      courseVersion: course.version,
      contentRef: course.contentRef,
      operation,
      audienceMode: course.audienceMode,
      audienceDepartmentIds: course.audienceDepartmentIds,
      audiencePositionIds: course.audiencePositionIds,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(course.updatedAt),
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      receiptId: null,
      indexedContentDigest: null,
      indexedAt: null,
      lastErrorCode: null,
    });
  });

  it.each([
    ['invalid-event', publishedCourse, 'upsert'],
    [EVENT_ID, null, 'upsert'],
    [EVENT_ID, { ...publishedCourse, id: '../course' }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, courseCode: 'unsafe code' }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, revision: 0 }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, version: 1.5 }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, version: Number.MAX_SAFE_INTEGER + 1 }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, contentRef: 'unsafe/content' }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, updatedAt: '2026-07-29T02:00:00Z' }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, status: 'draft' }, 'upsert'],
    [EVENT_ID, { ...publishedCourse, status: 'retired' }, 'upsert'],
    [EVENT_ID, publishedCourse, 'delete'],
    [EVENT_ID, retiredCourse, 'replace'],
    [EVENT_ID, {
      ...publishedCourse,
      audienceDepartmentIds: ['department-001'],
    }, 'upsert'],
    [EVENT_ID, {
      ...employmentCourse,
      audienceDepartmentIds: [],
      audiencePositionIds: [],
    }, 'upsert'],
    [EVENT_ID, {
      ...employmentCourse,
      audienceDepartmentIds: ['department-001', 'department-001'],
    }, 'upsert'],
    [EVENT_ID, {
      ...employmentCourse,
      audienceDepartmentIds: ['department-002', 'department-001'],
    }, 'upsert'],
    [EVENT_ID, {
      ...employmentCourse,
      audienceDepartmentIds: ['unsafe/id'],
    }, 'upsert'],
    [EVENT_ID, {
      ...employmentCourse,
      audiencePositionIds: Array.from(
        { length: 201 },
        (_, index) => `position-${String(index).padStart(3, '0')}`,
      ),
    }, 'upsert'],
  ])('拒绝非规范任务输入 %#', async (eventId, course, operation) => {
    const { writer, create } = setup();

    await expect(writer.append(
      eventId,
      course as CourseVersion,
      operation as 'upsert',
      session,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_INPUT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it('拒绝课程租户与可信租户不一致', async () => {
    const { writer, create } = setup();

    await expect(writer.append(
      EVENT_ID,
      { ...publishedCourse, tenantId: 'tenant-002' },
      'upsert',
      session,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_TENANT_MISMATCH');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [() => {
      throw new Error('上下文缺失');
    }],
    [() => ({ tenantId: '../tenant', source: 'access_token' })],
    [() => ({ source: 'access_token' })],
    [() => null],
  ])('拒绝缺失或受污染的可信租户上下文 %#', async (getTenantRequired) => {
    const { writer, create } = setup(getTenantRequired);

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      session,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_CONTEXT_INVALID');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{}],
    [{ inTransaction: 'true' }],
    [{ inTransaction: () => false }],
    [{ inTransaction: () => {
      throw new Error('会话损坏');
    } }],
  ])('拒绝非活动事务会话 %#', async (candidate) => {
    const { writer, create } = setup();

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      candidate as unknown as ClientSession,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_TRANSACTION_REQUIRED');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{}, {}]],
    [[{ eventId: 'wrong' }]],
  ])('拒绝无法反向绑定的数据库创建结果 %#', async (created) => {
    const { writer, create } = setup();
    create.mockResolvedValueOnce(created);

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      session,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_WRITE_UNAVAILABLE');
  });

  it.each([
    ['tenantId', 'tenant-002'],
    ['courseVersionId', 'course-version-002'],
    ['courseVersion', 3],
    ['operation', 'delete'],
    ['audienceDepartmentIds', ['department-999']],
    ['status', 'completed'],
    ['attempts', 1],
    ['nextAttemptAt', new Date('2026-07-29T02:00:01.000Z')],
    ['lockedBy', 'worker-001'],
  ] as const)('拒绝数据库回执篡改字段 %s', async (field, value) => {
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => Promise.resolve([{
      ...rows[0]!,
      [field]: value,
    }]));

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      session,
    )).rejects.toThrow('KNOWLEDGE_SEARCH_INDEX_TASK_WRITE_UNAVAILABLE');
  });

  it('接受 Mongoose 文档形态的可验证创建结果', async () => {
    const { writer, create } = setup();
    const toObject = vi.fn();
    create.mockImplementationOnce((rows) => {
      toObject.mockReturnValue(rows[0]);
      return Promise.resolve([{ toObject }]);
    });

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      session,
    )).resolves.toBeUndefined();
    expect(toObject).toHaveBeenCalledWith({
      depopulate: true,
      flattenMaps: true,
      versionKey: false,
    });
  });

  it('保留数据库异常供事务上层分类', async () => {
    const { writer, create } = setup();
    const failure = new Error('mongo unavailable');
    create.mockRejectedValueOnce(failure);

    await expect(writer.append(
      EVENT_ID,
      publishedCourse,
      'upsert',
      session,
    )).rejects.toBe(failure);
  });

  it('使用规范化副本阻止调用方在写入期间篡改授权范围', async () => {
    const mutable = {
      ...employmentCourse,
      audienceDepartmentIds: ['department-001', 'department-002'],
      audiencePositionIds: ['position-001'],
    } as CourseVersion;
    const { writer, create } = setup();
    create.mockImplementationOnce((rows) => {
      (mutable.audienceDepartmentIds as string[])[0] = 'department-999';
      return Promise.resolve(rows);
    });

    await writer.append(EVENT_ID, mutable, 'upsert', session);

    expect(create.mock.calls[0]![0][0]!.audienceDepartmentIds).toEqual([
      'department-001',
      'department-002',
    ]);
  });
});

function setup(
  getTenantRequired: () => unknown = () => ({
    tenantId: TENANT_ID,
    source: 'access_token',
  }),
): {
  readonly writer: KnowledgeSearchIndexTaskWriter;
  readonly create: Mock<CreateTask>;
} {
  const context = {
    getTenantRequired: vi.fn(getTenantRequired),
  } as unknown as TenantContextService;
  const create = vi.fn<CreateTask>((rows) => Promise.resolve(rows));
  const records = { create } as unknown as Model<KnowledgeSearchIndexTaskDocument>;
  return {
    writer: new KnowledgeSearchIndexTaskWriter(context, records),
    create,
  };
}
