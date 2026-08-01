import { pathToFileURL } from 'node:url';

import { createConnection, type Connection, type mongo } from 'mongoose';

const ACTIVE = ['starting', 'in_progress', 'submitted', 'pending_review'] as const;

export async function reconcileKnowledgeExamRuns(
  connection: Connection,
  now = new Date(),
) {
  const collection = connection.collection('knowledge_exam_runs');
  const [
    byStatus,
    overdueActions,
    staleLocks,
    gradingSlaBreaches,
    reviewSlaBreaches,
    inconsistentGradedRuns,
    orphanedAttempts,
    recentMissingTerminalEvents,
  ] =
    await Promise.all([
      collection.aggregate<{ readonly _id: string; readonly count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      collection.countDocuments({
        status: { $in: [...ACTIVE] },
        nextActionAt: { $lt: now },
      }),
      collection.countDocuments({
        lockedAt: { $lt: new Date(now.getTime() - 5 * 60_000) },
      }),
      collection.countDocuments({
        status: 'submitted',
        $expr: {
          $lt: [
            {
              $add: [
                '$submittedAt',
                { $multiply: ['$gradingSlaMinutes', 60_000] },
              ],
            },
            now,
          ],
        },
      }),
      collection.countDocuments({
        status: 'pending_review',
        $expr: {
          $lt: [
            {
              $add: [
                '$submittedAt',
                { $multiply: ['$manualReviewSlaMinutes', 60_000] },
              ],
            },
            now,
          ],
        },
      }),
      countAggregation(collection, buildInconsistentGradedRunsPipeline()),
      countAggregation(
        connection.collection('knowledge_exam_attempts'),
        buildOrphanedExamAttemptsPipeline(),
      ),
      countAggregation(
        collection,
        buildRecentMissingTerminalEventsPipeline(now),
      ),
    ]);
  const statusCounts = Object.freeze(Object.fromEntries(
    byStatus.map((item) => [item._id, item.count]),
  ));
  const dead = statusCounts.dead ?? 0;
  const manualInterventionRequired =
    dead + staleLocks + gradingSlaBreaches + reviewSlaBreaches +
    inconsistentGradedRuns + orphanedAttempts + recentMissingTerminalEvents;
  return Object.freeze({
    mode: 'read-only',
    checkedAt: now.toISOString(),
    byStatus: statusCounts,
    overdueActions,
    staleLocks,
    gradingSlaBreaches,
    reviewSlaBreaches,
    inconsistentGradedRuns,
    orphanedAttempts,
    recentMissingTerminalEvents,
    manualInterventionRequired,
    ready:
      overdueActions === 0 &&
      staleLocks === 0 &&
      manualInterventionRequired === 0,
  });
}

/** 找出已评分运行与不可变最终尝试在租户、任务、次数或证据摘要上的错位。 */
export function buildInconsistentGradedRunsPipeline(): readonly mongo.Document[] {
  return Object.freeze([
    { $match: { status: 'graded' } },
    {
      $lookup: {
        from: 'knowledge_exam_attempts',
        let: {
          tenantId: '$tenantId',
          finalAttemptId: '$finalAttemptId',
          assignmentId: '$assignmentId',
          attemptNumber: '$attemptNumber',
          submissionRef: '$submissionRef',
          questionSetDigest: '$questionSetDigest',
        },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$tenantId', '$$tenantId'] },
                { $eq: ['$id', '$$finalAttemptId'] },
                { $eq: ['$assignmentId', '$$assignmentId'] },
                { $eq: ['$attemptNumber', '$$attemptNumber'] },
                { $eq: ['$submissionRef', '$$submissionRef'] },
                { $eq: ['$questionSetDigest', '$$questionSetDigest'] },
              ],
            },
          },
        }],
        as: 'consistentAttempts',
      },
    },
    { $match: { $expr: { $ne: [{ $size: '$consistentAttempts' }, 1] } } },
    { $count: 'count' },
  ]);
}

/** 找出没有唯一已评分考试运行引用的最终尝试。 */
export function buildOrphanedExamAttemptsPipeline(): readonly mongo.Document[] {
  return Object.freeze([
    {
      $lookup: {
        from: 'knowledge_exam_runs',
        let: {
          tenantId: '$tenantId',
          attemptId: '$id',
          assignmentId: '$assignmentId',
          attemptNumber: '$attemptNumber',
        },
        pipeline: [{
          $match: {
            status: 'graded',
            $expr: {
              $and: [
                { $eq: ['$tenantId', '$$tenantId'] },
                { $eq: ['$finalAttemptId', '$$attemptId'] },
                { $eq: ['$assignmentId', '$$assignmentId'] },
                { $eq: ['$attemptNumber', '$$attemptNumber'] },
              ],
            },
          },
        }],
        as: 'gradedRuns',
      },
    },
    { $match: { $expr: { $ne: [{ $size: '$gradedRuns' }, 1] } } },
    { $count: 'count' },
  ]);
}

/** Outbox 有 30 天 TTL，因此只核对最近 29 天终态事件，避免把正常归档误报为丢失。 */
export function buildRecentMissingTerminalEventsPipeline(
  now: Date,
): readonly mongo.Document[] {
  return Object.freeze([
    {
      $match: {
        status: { $in: ['graded', 'dead'] },
        updatedAt: { $gte: new Date(now.getTime() - 29 * 24 * 60 * 60_000) },
      },
    },
    {
      $set: {
        expectedAggregateId: {
          $cond: [{ $eq: ['$status', 'graded'] }, '$finalAttemptId', '$id'],
        },
        expectedAggregateVersion: {
          $cond: [{ $eq: ['$status', 'graded'] }, 1, '$version'],
        },
        expectedEventType: {
          $cond: [
            { $eq: ['$status', 'graded'] },
            'cn.gaoq.erp.knowledge.exam.graded.v1',
            'cn.gaoq.erp.knowledge.exam.run.dead.v1',
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'integration_outbox',
        let: {
          tenantId: '$tenantId',
          aggregateId: '$expectedAggregateId',
          aggregateVersion: '$expectedAggregateVersion',
          eventType: '$expectedEventType',
        },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$tenantId', '$$tenantId'] },
                { $eq: ['$aggregateId', '$$aggregateId'] },
                { $eq: ['$aggregateVersion', '$$aggregateVersion'] },
                { $eq: ['$eventType', '$$eventType'] },
              ],
            },
          },
        }],
        as: 'terminalEvents',
      },
    },
    { $match: { $expr: { $ne: [{ $size: '$terminalEvents' }, 1] } } },
    { $count: 'count' },
  ]);
}

async function countAggregation(
  collection: ReturnType<Connection['collection']>,
  pipeline: readonly mongo.Document[],
): Promise<number> {
  const rows = await collection.aggregate<{ readonly count: number }>([...pipeline]).toArray();
  return rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 0) throw new Error('KNOWLEDGE_EXAM_RECONCILE_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('KNOWLEDGE_EXAM_RECONCILE_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    process.stdout.write(`${JSON.stringify(await reconcileKnowledgeExamRuns(connection))}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^KNOWLEDGE_EXAM_RECONCILE_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'KNOWLEDGE_EXAM_RECONCILE_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
