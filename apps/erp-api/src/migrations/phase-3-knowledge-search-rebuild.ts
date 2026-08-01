import { pathToFileURL } from 'node:url';

import { createEventId } from '@gaoq/shared-utils';
import {
  createConnection,
  type Connection,
  type mongo,
} from 'mongoose';

import type { KnowledgeSearchIndexTaskRecord } from '../modules/knowledge/persistence/knowledge-search.schemas.js';

const MIGRATION_ID = 'phase-3-knowledge-search-rebuild-v1';
const BATCH_SIZE = 500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface CourseRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly version: number;
  readonly contentRef: string;
  readonly status: 'published' | 'retired';
  readonly audienceMode?: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds?: readonly string[];
  readonly audiencePositionIds?: readonly string[];
  readonly updatedAt: Date;
}

export interface KnowledgeSearchRebuildResult {
  readonly scanned: number;
  readonly legacyAudienceBackfills: number;
  readonly tasksPrepared: number;
  readonly forceReplayRequested: boolean;
}

export async function runKnowledgeSearchRebuild(
  connection: Connection,
  mode: 'dry-run' | 'apply' | 'force-replay',
): Promise<KnowledgeSearchRebuildResult> {
  const courses = connection.collection<CourseRecord>('knowledge_course_versions');
  const tasks = connection.collection<KnowledgeSearchIndexTaskRecord>(
    'knowledge_search_index_tasks',
  );
  let scanned = 0;
  let legacyAudienceBackfills = 0;
  let tasksPrepared = 0;
  let activeCourseKey: string | null = null;
  let currentPublishedSelected = false;
  let courseWrites: mongo.AnyBulkWriteOperation<CourseRecord>[] = [];
  let taskWrites: mongo.AnyBulkWriteOperation<KnowledgeSearchIndexTaskRecord>[] = [];
  const cursor = courses.find(
    { status: { $in: ['published', 'retired'] } },
    {
      projection: {
        _id: 0,
        id: 1,
        tenantId: 1,
        courseCode: 1,
        revision: 1,
        version: 1,
        contentRef: 1,
        status: 1,
        audienceMode: 1,
        audienceDepartmentIds: 1,
        audiencePositionIds: 1,
        updatedAt: 1,
      },
    },
  ).sort({ tenantId: 1, courseCode: 1, revision: -1, id: 1 }).batchSize(BATCH_SIZE);

  for await (const course of cursor) {
    const audience = normalizeAudience(course);
    const courseKey = `${course.tenantId}\u0000${course.courseCode}`;
    if (courseKey !== activeCourseKey) {
      activeCourseKey = courseKey;
      currentPublishedSelected = false;
    }
    const operation = course.status === 'published' && !currentPublishedSelected
      ? 'upsert'
      : 'delete';
    if (operation === 'upsert') currentPublishedSelected = true;
    scanned += 1;
    if (audience.legacy) legacyAudienceBackfills += 1;
    tasksPrepared += 1;
    if (mode === 'dry-run') continue;
    if (audience.legacy) courseWrites.push({
      updateOne: {
        filter: {
          tenantId: course.tenantId,
          id: course.id,
          audienceMode: { $exists: false },
        },
        update: {
          $set: {
            audienceMode: 'assigned_only',
            audienceDepartmentIds: [],
            audiencePositionIds: [],
          },
        },
      },
    });
    const now = new Date();
    taskWrites.push({
      updateOne: {
        filter: {
          tenantId: course.tenantId,
          courseVersionId: course.id,
          courseVersion: course.version,
          operation,
        },
        update: {
          $setOnInsert: {
            eventId: createEventId(course.updatedAt),
            tenantId: course.tenantId,
            courseVersionId: course.id,
            courseCode: course.courseCode,
            revision: course.revision,
            courseVersion: course.version,
            contentRef: course.contentRef,
            operation,
            audienceMode: audience.mode,
            audienceDepartmentIds: [...audience.departmentIds],
            audiencePositionIds: [...audience.positionIds],
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedAt: null,
            lockedBy: null,
            completedAt: null,
            receiptId: null,
            indexedContentDigest: null,
            indexedAt: null,
            lastErrorCode: null,
          },
        },
        upsert: true,
      },
    });
    if (mode === 'force-replay') taskWrites.push({
      updateOne: {
        filter: {
          tenantId: course.tenantId,
          courseVersionId: course.id,
          courseVersion: course.version,
          operation,
        },
        update: {
          $set: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedAt: null,
            lockedBy: null,
            completedAt: null,
            receiptId: null,
            indexedContentDigest: null,
            indexedAt: null,
            lastErrorCode: null,
          },
        },
      },
    });
    if (tasksPrepared % BATCH_SIZE === 0) {
      if (courseWrites.length > 0) {
        await courses.bulkWrite(courseWrites, { ordered: true });
      }
      if (taskWrites.length > 0) {
        await tasks.bulkWrite(taskWrites, { ordered: true });
      }
      courseWrites = [];
      taskWrites = [];
    }
  }
  if (mode !== 'dry-run') {
    if (courseWrites.length > 0) {
      await courses.bulkWrite(courseWrites, { ordered: true });
    }
    if (taskWrites.length > 0) {
      await tasks.bulkWrite(taskWrites, { ordered: true });
    }
  }
  return Object.freeze({
    scanned,
    legacyAudienceBackfills,
    tasksPrepared,
    forceReplayRequested: mode === 'force-replay',
  });
}

function normalizeAudience(course: CourseRecord): {
  readonly mode: 'assigned_only' | 'employment_scope';
  readonly departmentIds: readonly string[];
  readonly positionIds: readonly string[];
  readonly legacy: boolean;
} {
  for (const value of [
    course.id,
    course.tenantId,
    course.courseCode,
    course.contentRef,
  ]) if (!SAFE_ID.test(value)) throw new Error('KNOWLEDGE_SEARCH_REBUILD_RECORD_INVALID');
  if (
    !Number.isSafeInteger(course.revision) || course.revision < 1 ||
    !Number.isSafeInteger(course.version) || course.version < 1 ||
    !(course.updatedAt instanceof Date) ||
    Number.isNaN(course.updatedAt.getTime())
  ) throw new Error('KNOWLEDGE_SEARCH_REBUILD_RECORD_INVALID');
  const legacy = course.audienceMode === undefined;
  const mode = course.audienceMode ?? 'assigned_only';
  const departmentIds = normalizeIds(course.audienceDepartmentIds ?? []);
  const positionIds = normalizeIds(course.audiencePositionIds ?? []);
  if (
    (mode === 'assigned_only' && (departmentIds.length > 0 || positionIds.length > 0)) ||
    (mode === 'employment_scope' && departmentIds.length === 0 && positionIds.length === 0)
  ) throw new Error('KNOWLEDGE_SEARCH_REBUILD_AUDIENCE_INVALID');
  return Object.freeze({ mode, departmentIds, positionIds, legacy });
}

function normalizeIds(values: readonly string[]): readonly string[] {
  if (
    values.length > 200 ||
    new Set<string>(values).size !== values.length ||
    values.some((value) => !SAFE_ID.test(value))
  ) throw new Error('KNOWLEDGE_SEARCH_REBUILD_AUDIENCE_INVALID');
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (
    args.length !== 1 ||
    !['--dry-run', '--apply', '--force-replay'].includes(args[0] ?? '')
  ) throw new Error('KNOWLEDGE_SEARCH_REBUILD_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('KNOWLEDGE_SEARCH_REBUILD_MONGODB_URI_REQUIRED');
  }
  const mode = args[0] === '--dry-run'
    ? 'dry-run'
    : args[0] === '--apply'
      ? 'apply'
      : 'force-replay';
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const result = await runKnowledgeSearchRebuild(connection, mode);
    process.stdout.write(`${JSON.stringify({ migrationId: MIGRATION_ID, mode, ...result })}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error &&
      /^KNOWLEDGE_SEARCH_REBUILD_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'KNOWLEDGE_SEARCH_REBUILD_EXECUTION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
