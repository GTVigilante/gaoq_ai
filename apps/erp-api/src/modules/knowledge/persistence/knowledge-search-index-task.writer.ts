import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CourseVersion } from '../domain/index.js';
import {
  KnowledgeSearchIndexTaskRecord,
  type KnowledgeSearchIndexTaskDocument,
  type KnowledgeSearchIndexOperation,
} from './knowledge-search.schemas.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COURSE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
const audienceIdsSchema = z.array(safeIdSchema).max(200).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'audience_duplicate' });
  }
  if (
    !isDeepStrictEqual(
      values,
      [...values].sort((left, right) => left.localeCompare(right)),
    )
  ) context.addIssue({ code: 'custom', message: 'audience_not_canonical' });
});
const taskInputSchema = z.object({
  eventId: z.string().regex(ULID_PATTERN),
  tenantId: safeIdSchema,
  courseVersionId: safeIdSchema,
  courseCode: z.string().regex(COURSE_CODE_PATTERN),
  revision: positiveSafeIntegerSchema,
  courseVersion: positiveSafeIntegerSchema,
  contentRef: safeIdSchema,
  operation: z.enum(['upsert', 'delete']),
  courseStatus: z.enum(['published', 'retired']),
  audienceMode: z.enum(['assigned_only', 'employment_scope']),
  audienceDepartmentIds: audienceIdsSchema,
  audiencePositionIds: audienceIdsSchema,
  updatedAt: canonicalInstantSchema,
}).strict().superRefine((value, context) => {
  if (
    (value.operation === 'upsert' && value.courseStatus !== 'published') ||
    (value.operation === 'delete' && value.courseStatus !== 'retired')
  ) context.addIssue({ code: 'custom', message: 'operation_status_mismatch' });
  const hasEmploymentScope =
    value.audienceDepartmentIds.length > 0 ||
    value.audiencePositionIds.length > 0;
  if (
    (value.audienceMode === 'assigned_only' && hasEmploymentScope) ||
    (value.audienceMode === 'employment_scope' && !hasEmploymentScope)
  ) context.addIssue({ code: 'custom', message: 'audience_mode_mismatch' });
});

type CanonicalTaskInput = z.infer<typeof taskInputSchema>;

interface InitialTaskRow {
  readonly eventId: string;
  readonly tenantId: string;
  readonly courseVersionId: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly courseVersion: number;
  readonly contentRef: string;
  readonly operation: KnowledgeSearchIndexOperation;
  readonly audienceMode: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds: string[];
  readonly audiencePositionIds: string[];
  readonly status: 'pending';
  readonly attempts: 0;
  readonly nextAttemptAt: Date;
  readonly lockedAt: null;
  readonly lockedBy: null;
  readonly completedAt: null;
  readonly receiptId: null;
  readonly indexedContentDigest: null;
  readonly indexedAt: null;
  readonly lastErrorCode: null;
}

/**
 * 在课程发布/下架事务内追加搜索索引任务。
 * 只保存规范授权投影，禁止同步调用外部搜索服务或接受非活动事务。
 */
@Injectable()
export class KnowledgeSearchIndexTaskWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(KnowledgeSearchIndexTaskRecord.name)
    private readonly records: Model<KnowledgeSearchIndexTaskDocument>,
  ) {}

  async append(
    eventId: string,
    course: CourseVersion,
    operation: KnowledgeSearchIndexOperation,
    session: ClientSession,
  ): Promise<void> {
    const tenantId = this.tenantId();
    const canonical = parseTaskInput(eventId, course, operation);
    if (canonical.tenantId !== tenantId) {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const row: InitialTaskRow = {
      eventId: canonical.eventId,
      tenantId,
      courseVersionId: canonical.courseVersionId,
      courseCode: canonical.courseCode,
      revision: canonical.revision,
      courseVersion: canonical.courseVersion,
      contentRef: canonical.contentRef,
      operation: canonical.operation,
      audienceMode: canonical.audienceMode,
      audienceDepartmentIds: [...canonical.audienceDepartmentIds],
      audiencePositionIds: [...canonical.audiencePositionIds],
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(canonical.updatedAt),
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      receiptId: null,
      indexedContentDigest: null,
      indexedAt: null,
      lastErrorCode: null,
    };
    const created = await this.records.create([row], { session });
    assertCreatedTask(created, row);
  }

  private tenantId(): string {
    let trusted: unknown;
    try {
      trusted = this.context.getTenantRequired();
    } catch {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_CONTEXT_INVALID');
    }
    const parsed = z.object({ tenantId: safeIdSchema }).passthrough().safeParse(trusted);
    if (!parsed.success) {
      throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_CONTEXT_INVALID');
    }
    return parsed.data.tenantId;
  }
}

function parseTaskInput(
  eventId: unknown,
  course: unknown,
  operation: unknown,
): CanonicalTaskInput {
  if (course === null || typeof course !== 'object') {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_INPUT_INVALID');
  }
  const candidate = course as Partial<CourseVersion>;
  const parsed = taskInputSchema.safeParse({
    eventId,
    tenantId: candidate.tenantId,
    courseVersionId: candidate.id,
    courseCode: candidate.courseCode,
    revision: candidate.revision,
    courseVersion: candidate.version,
    contentRef: candidate.contentRef,
    operation,
    courseStatus: candidate.status,
    audienceMode: candidate.audienceMode,
    audienceDepartmentIds: copyArray(candidate.audienceDepartmentIds),
    audiencePositionIds: copyArray(candidate.audiencePositionIds),
    updatedAt: candidate.updatedAt,
  });
  if (!parsed.success) {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_INPUT_INVALID');
  }
  return deepFreeze(parsed.data);
}

function copyArray(value: unknown): unknown {
  return Array.isArray(value) ? Array.from(value as readonly unknown[]) : value;
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_TRANSACTION_REQUIRED');
}

function assertCreatedTask(created: unknown, expected: InitialTaskRow): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_WRITE_UNAVAILABLE');
  }
  const parsed = z.object({
    eventId: z.literal(expected.eventId),
    tenantId: z.literal(expected.tenantId),
    courseVersionId: z.literal(expected.courseVersionId),
    courseCode: z.literal(expected.courseCode),
    revision: z.literal(expected.revision),
    courseVersion: z.literal(expected.courseVersion),
    contentRef: z.literal(expected.contentRef),
    operation: z.literal(expected.operation),
    audienceMode: z.literal(expected.audienceMode),
    audienceDepartmentIds: z.custom(
      (value) => isDeepStrictEqual(value, expected.audienceDepartmentIds),
    ),
    audiencePositionIds: z.custom(
      (value) => isDeepStrictEqual(value, expected.audiencePositionIds),
    ),
    status: z.literal('pending'),
    attempts: z.literal(0),
    nextAttemptAt: z.date().refine(
      (value) => value.getTime() === expected.nextAttemptAt.getTime(),
    ),
    lockedAt: z.null(),
    lockedBy: z.null(),
    completedAt: z.null(),
    receiptId: z.null(),
    indexedContentDigest: z.null(),
    indexedAt: z.null(),
    lastErrorCode: z.null(),
  }).passthrough().safeParse(asPlainObject(created[0]));
  if (!parsed.success) {
    throw new Error('KNOWLEDGE_SEARCH_INDEX_TASK_WRITE_UNAVAILABLE');
  }
}

function asPlainObject(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    'toObject' in value &&
    typeof (value as { readonly toObject?: unknown }).toObject === 'function'
  ) {
    return (value as { toObject: (options: Record<string, boolean>) => unknown }).toObject({
      depopulate: true,
      flattenMaps: true,
      versionKey: false,
    });
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
