import { pathToFileURL } from 'node:url';

import { createConnection, type Connection, type mongo } from 'mongoose';

const MIGRATION_ID = 'phase-3-knowledge-search-reconcile-v1';

interface ReconciliationAggregate {
  readonly expected: number;
  readonly completed: number;
  readonly missing: number;
  readonly pending: number;
  readonly dead: number;
  readonly stale: number;
}

export interface KnowledgeSearchReconciliationResult extends ReconciliationAggregate {
  readonly ready: boolean;
}

/** 仅以非正文业务键和签名回执状态对账，不读取内容、身份或授权成员明细。 */
export function buildKnowledgeSearchReconciliationPipeline(): readonly mongo.Document[] {
  return Object.freeze([
    {
      $match: {
        status: { $in: ['published', 'retired'] },
      },
    },
    {
      $set: {
        publishedPriority: {
          $cond: [{ $eq: ['$status', 'published'] }, 0, 1],
        },
      },
    },
    {
      $setWindowFields: {
        partitionBy: { tenantId: '$tenantId', courseCode: '$courseCode' },
        sortBy: { publishedPriority: 1, revision: -1, id: 1 },
        output: { publishedOrder: { $documentNumber: {} } },
      },
    },
    {
      $set: {
        expectedOperation: {
          $cond: [
            {
              $and: [
                { $eq: ['$status', 'published'] },
                { $eq: ['$publishedOrder', 1] },
              ],
            },
            'upsert',
            'delete',
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'knowledge_search_index_tasks',
        let: {
          expectedTenantId: '$tenantId',
          expectedCourseVersionId: '$id',
          expectedCourseVersion: '$version',
          expectedOperation: '$expectedOperation',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', '$$expectedTenantId'] },
                  { $eq: ['$courseVersionId', '$$expectedCourseVersionId'] },
                  { $eq: ['$courseVersion', '$$expectedCourseVersion'] },
                  { $eq: ['$operation', '$$expectedOperation'] },
                ],
              },
            },
          },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              status: 1,
              indexedAt: 1,
              receiptId: 1,
              indexedContentDigest: 1,
            },
          },
        ],
        as: 'matchingTasks',
      },
    },
    {
      $set: {
        task: { $arrayElemAt: ['$matchingTasks', 0] },
      },
    },
    {
      $group: {
        _id: null,
        expected: { $sum: 1 },
        completed: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$task.status', 'completed'] },
                  { $ne: ['$task.receiptId', null] },
                  { $ne: ['$task.indexedContentDigest', null] },
                  { $gte: ['$task.indexedAt', '$updatedAt'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        missing: {
          $sum: {
            $cond: [{ $eq: [{ $type: '$task' }, 'missing'] }, 1, 0],
          },
        },
        pending: {
          $sum: {
            $cond: [{ $in: ['$task.status', ['pending', 'processing']] }, 1, 0],
          },
        },
        dead: {
          $sum: {
            $cond: [{ $eq: ['$task.status', 'dead'] }, 1, 0],
          },
        },
        stale: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$task.status', 'completed'] },
                  { $lt: ['$task.indexedAt', '$updatedAt'] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        expected: 1,
        completed: 1,
        missing: 1,
        pending: 1,
        dead: 1,
        stale: 1,
      },
    },
  ]);
}

export async function runKnowledgeSearchReconciliation(
  connection: Connection,
): Promise<KnowledgeSearchReconciliationResult> {
  const rows = await connection
    .collection('knowledge_course_versions')
    .aggregate<ReconciliationAggregate>([
      ...buildKnowledgeSearchReconciliationPipeline(),
    ], { allowDiskUse: true })
    .toArray();
  const row = rows[0] ?? {
    expected: 0,
    completed: 0,
    missing: 0,
    pending: 0,
    dead: 0,
    stale: 0,
  };
  return Object.freeze({
    ...row,
    ready:
      row.completed === row.expected &&
      row.missing === 0 &&
      row.pending === 0 &&
      row.dead === 0 &&
      row.stale === 0,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 0) throw new Error('KNOWLEDGE_SEARCH_RECONCILE_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('KNOWLEDGE_SEARCH_RECONCILE_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const result = await runKnowledgeSearchReconciliation(connection);
    process.stdout.write(`${JSON.stringify({
      migrationId: MIGRATION_ID,
      mode: 'read-only',
      ...result,
    })}\n`);
    if (!result.ready) process.exitCode = 2;
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error &&
      /^KNOWLEDGE_SEARCH_RECONCILE_[A-Z_]{1,96}$/.test(error.message)
      ? error.message
      : 'KNOWLEDGE_SEARCH_RECONCILE_EXECUTION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
