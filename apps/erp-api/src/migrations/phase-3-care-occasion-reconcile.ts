import { pathToFileURL } from 'node:url';

import { createConnection, type Connection } from 'mongoose';

export async function reconcileCareOccasions(
  connection: Connection,
  now = new Date(),
) {
  const tasks = connection.collection('care_occasion_tasks');
  const [
    byStatus,
    overduePending,
    staleLocks,
    inconsistentStates,
    duplicateNaturalKeys,
    duplicateDeliveryEvidence,
    orphanPreferences,
    recentMissingTerminalEvents,
  ] = await Promise.all([
    tasks.aggregate<{ readonly _id: string; readonly count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    tasks.countDocuments({
      status: 'pending',
      nextAttemptAt: { $lt: now },
      scheduledAt: { $lt: now },
    }),
    tasks.countDocuments({
      status: 'dispatching',
      lockedAt: { $lt: new Date(now.getTime() - 15 * 60_000) },
    }),
    countAggregation(tasks, buildInconsistentOccasionStatePipeline()),
    countAggregation(tasks, buildDuplicateNaturalKeyPipeline()),
    countAggregation(tasks, buildDuplicateDeliveryEvidencePipeline()),
    countAggregation(
      connection.collection('care_occasion_preferences'),
      buildOrphanPreferencePipeline(),
    ),
    countAggregation(tasks, buildRecentMissingOccasionEventPipeline(now)),
  ]);
  const statusCounts = Object.freeze(Object.fromEntries(
    byStatus.map((item) => [item._id, item.count]),
  ));
  const dead = statusCounts.dead ?? 0;
  const manualInterventionRequired =
    dead +
    staleLocks +
    inconsistentStates +
    duplicateNaturalKeys +
    duplicateDeliveryEvidence +
    orphanPreferences +
    recentMissingTerminalEvents;
  return Object.freeze({
    mode: 'read-only',
    checkedAt: now.toISOString(),
    byStatus: statusCounts,
    overduePending,
    staleLocks,
    inconsistentStates,
    duplicateNaturalKeys,
    duplicateDeliveryEvidence,
    orphanPreferences,
    recentMissingTerminalEvents,
    manualInterventionRequired,
    ready: overduePending === 0 && manualInterventionRequired === 0,
  });
}

/** 检测锁、送达证据与取消原因组合是否匹配任务状态。 */
export function buildInconsistentOccasionStatePipeline() {
  return Object.freeze([
    {
      $match: {
        $expr: {
          $not: {
            $or: [
              {
                $and: [
                  { $eq: ['$status', 'dispatching'] },
                  { $ne: ['$lockedAt', null] },
                  { $ne: ['$lockedBy', null] },
                  { $eq: ['$deliveryEvidenceId', null] },
                  { $eq: ['$deliveredAt', null] },
                  { $eq: ['$denialCode', null] },
                ],
              },
              {
                $and: [
                  { $eq: ['$status', 'delivered'] },
                  { $eq: ['$lockedAt', null] },
                  { $eq: ['$lockedBy', null] },
                  { $ne: ['$deliveryEvidenceId', null] },
                  { $ne: ['$deliveredAt', null] },
                  { $eq: ['$denialCode', null] },
                ],
              },
              {
                $and: [
                  { $eq: ['$status', 'cancelled'] },
                  { $eq: ['$lockedAt', null] },
                  { $eq: ['$lockedBy', null] },
                  { $eq: ['$deliveryEvidenceId', null] },
                  { $eq: ['$deliveredAt', null] },
                  { $ne: ['$denialCode', null] },
                ],
              },
              {
                $and: [
                  { $in: ['$status', ['pending', 'dead']] },
                  { $eq: ['$lockedAt', null] },
                  { $eq: ['$lockedBy', null] },
                  { $eq: ['$deliveryEvidenceId', null] },
                  { $eq: ['$deliveredAt', null] },
                  { $eq: ['$denialCode', null] },
                ],
              },
            ],
          },
        },
      },
    },
    { $count: 'count' },
  ]);
}

export function buildDuplicateNaturalKeyPipeline() {
  return Object.freeze([
    {
      $group: {
        _id: {
          tenantId: '$tenantId',
          employeeId: '$employeeId',
          occasionType: '$occasionType',
          occurrenceYear: '$occurrenceYear',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'count' },
  ]);
}

export function buildDuplicateDeliveryEvidencePipeline() {
  return Object.freeze([
    { $match: { deliveryEvidenceId: { $type: 'string' } } },
    {
      $group: {
        _id: { tenantId: '$tenantId', deliveryEvidenceId: '$deliveryEvidenceId' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'count' },
  ]);
}

export function buildOrphanPreferencePipeline() {
  return Object.freeze([
    {
      $lookup: {
        from: 'org_employees',
        let: { tenantId: '$tenantId', employeeId: '$employeeId' },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$tenantId', '$$tenantId'] },
                { $eq: ['$id', '$$employeeId'] },
              ],
            },
          },
        }],
        as: 'employees',
      },
    },
    { $match: { $expr: { $ne: [{ $size: '$employees' }, 1] } } },
    { $count: 'count' },
  ]);
}

/** Outbox 已投递事件保留 30 天，因此只核对最近 29 天终态。 */
export function buildRecentMissingOccasionEventPipeline(now: Date) {
  return Object.freeze([
    {
      $match: {
        status: { $in: ['delivered', 'cancelled', 'dead'] },
        updatedAt: { $gte: new Date(now.getTime() - 29 * 24 * 60 * 60_000) },
      },
    },
    {
      $set: {
        expectedEventType: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$status', 'delivered'] },
                then: 'cn.gaoq.erp.care.occasion.delivered.v1',
              },
              {
                case: { $eq: ['$status', 'cancelled'] },
                then: 'cn.gaoq.erp.care.occasion.cancelled.v1',
              },
            ],
            default: 'cn.gaoq.erp.care.occasion.dead.v1',
          },
        },
      },
    },
    {
      $lookup: {
        from: 'integration_outbox',
        let: {
          tenantId: '$tenantId',
          aggregateId: '$id',
          aggregateVersion: '$version',
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
  pipeline: readonly object[],
): Promise<number> {
  const rows = await collection.aggregate<{ readonly count: number }>([...pipeline]).toArray();
  return rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length !== 0) throw new Error('CARE_OCCASION_RECONCILE_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('CARE_OCCASION_RECONCILE_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    process.stdout.write(`${JSON.stringify(await reconcileCareOccasions(connection))}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^CARE_OCCASION_RECONCILE_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'CARE_OCCASION_RECONCILE_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
