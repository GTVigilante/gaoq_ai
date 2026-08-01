import { pathToFileURL } from 'node:url';

import { createConnection, type Connection } from 'mongoose';

import { parseCareAlumniCleanupTargets } from '../config/care-alumni-cleanup-targets.js';

export async function reconcileCareAlumniCleanup(
  connection: Connection,
  targets: readonly { readonly targetCode: string; readonly policyVersion: string }[],
  now = new Date(),
) {
  const tasks = connection.collection('care_alumni_cleanup_tasks');
  const [
    byStatus,
    overduePending,
    staleLocks,
    inconsistentStates,
    duplicateNaturalKeys,
    duplicateProofDigests,
    missingTargetCoverage,
    recentMissingTerminalEvents,
    deadSourceEvents,
  ] = await Promise.all([
    tasks.aggregate<{ readonly _id: string; readonly count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    tasks.countDocuments({ status: 'pending', nextAttemptAt: { $lt: now } }),
    tasks.countDocuments({
      status: 'dispatching',
      lockedAt: { $lt: new Date(now.getTime() - 15 * 60_000) },
    }),
    countAggregation(tasks, buildInconsistentCleanupStatePipeline()),
    countAggregation(tasks, buildDuplicateCleanupNaturalKeyPipeline()),
    countAggregation(tasks, buildDuplicateCleanupProofPipeline()),
    targets.length === 0
      ? connection.collection('care_alumni_consents').countDocuments({
          status: { $in: ['withdrawn', 'expired'] },
        })
      : countAggregation(
          connection.collection('care_alumni_consents'),
          buildMissingCleanupTargetCoveragePipeline(targets),
        ),
    countAggregation(tasks, buildRecentMissingCleanupEventPipeline(now)),
    connection.collection('integration_outbox').countDocuments({
      eventType: { $in: [
        'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
        'cn.gaoq.erp.care.alumni_consent.expired.v1',
      ] },
      status: 'dead',
    }),
  ]);
  const statusCounts = Object.freeze(Object.fromEntries(
    byStatus.map((item) => [item._id, item.count]),
  ));
  const manualInterventionRequired =
    (statusCounts.dead ?? 0) +
    staleLocks +
    inconsistentStates +
    duplicateNaturalKeys +
    duplicateProofDigests +
    missingTargetCoverage +
    recentMissingTerminalEvents +
    deadSourceEvents;
  return Object.freeze({
    mode: 'read-only',
    checkedAt: now.toISOString(),
    registeredTargetCount: targets.length,
    byStatus: statusCounts,
    overduePending,
    staleLocks,
    inconsistentStates,
    duplicateNaturalKeys,
    duplicateProofDigests,
    missingTargetCoverage,
    recentMissingTerminalEvents,
    deadSourceEvents,
    manualInterventionRequired,
    ready: overduePending === 0 && manualInterventionRequired === 0,
  });
}

export function buildInconsistentCleanupStatePipeline() {
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
                  { $eq: ['$proofDigest', null] },
                ],
              },
              {
                $and: [
                  { $eq: ['$status', 'completed'] },
                  { $eq: ['$lockedAt', null] },
                  { $eq: ['$lockedBy', null] },
                  { $ne: ['$proofDigest', null] },
                  { $ne: ['$proofAction', null] },
                  { $in: ['$proofStorage', ['immutable_worm', 'append_only_ledger']] },
                  { $ne: ['$proofCompletedAt', null] },
                  { $ne: ['$proofRetentionUntil', null] },
                  { $ne: ['$proofKeyId', null] },
                ],
              },
              {
                $and: [
                  { $in: ['$status', ['pending', 'dead']] },
                  { $eq: ['$lockedAt', null] },
                  { $eq: ['$lockedBy', null] },
                  { $eq: ['$proofDigest', null] },
                  { $eq: ['$proofAction', null] },
                  { $eq: ['$proofStorage', null] },
                  { $eq: ['$proofCompletedAt', null] },
                  { $eq: ['$proofRetentionUntil', null] },
                  { $eq: ['$proofKeyId', null] },
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

export function buildDuplicateCleanupNaturalKeyPipeline() {
  return Object.freeze([
    {
      $group: {
        _id: {
          tenantId: '$tenantId',
          consentId: '$consentId',
          consentVersion: '$consentVersion',
          consentPurpose: '$consentPurpose',
          targetCode: '$targetCode',
          policyVersion: '$policyVersion',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'count' },
  ]);
}

export function buildDuplicateCleanupProofPipeline() {
  return Object.freeze([
    { $match: { proofDigest: { $type: 'string' } } },
    {
      $group: {
        _id: { tenantId: '$tenantId', proofDigest: '$proofDigest' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'count' },
  ]);
}

export function buildMissingCleanupTargetCoveragePipeline(
  targets: readonly { readonly targetCode: string; readonly policyVersion: string }[],
) {
  const expected = targets.map((target) =>
    `${target.targetCode}:${target.policyVersion}`);
  return Object.freeze([
    { $match: { status: { $in: ['withdrawn', 'expired'] } } },
    {
      $lookup: {
        from: 'care_alumni_cleanup_tasks',
        let: {
          tenantId: '$tenantId',
          consentId: '$id',
          consentVersion: '$version',
          consentPurpose: '$purpose',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', '$$tenantId'] },
                  { $eq: ['$consentId', '$$consentId'] },
                  { $eq: ['$consentVersion', '$$consentVersion'] },
                  { $eq: ['$consentPurpose', '$$consentPurpose'] },
                ],
              },
            },
          },
          { $project: { key: { $concat: ['$targetCode', ':', '$policyVersion'] } } },
        ],
        as: 'cleanupTasks',
      },
    },
    {
      $match: {
        $expr: {
          $gt: [{
            $size: {
              $setDifference: [
                expected,
                { $map: {
                  input: '$cleanupTasks',
                  as: 'task',
                  in: '$$task.key',
                } },
              ],
            },
          }, 0],
        },
      },
    },
    { $count: 'count' },
  ]);
}

/** Outbox 已投递事件只保留 30 天，因此核对最近 29 天 completed/dead 终态。 */
export function buildRecentMissingCleanupEventPipeline(now: Date) {
  return Object.freeze([
    {
      $match: {
        status: { $in: ['completed', 'dead'] },
        updatedAt: { $gte: new Date(now.getTime() - 29 * 24 * 60 * 60_000) },
      },
    },
    {
      $set: {
        expectedEventType: {
          $cond: [
            { $eq: ['$status', 'completed'] },
            'cn.gaoq.erp.care.alumni_cleanup.completed.v1',
            'cn.gaoq.erp.care.alumni_cleanup.dead.v1',
          ],
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
  const rows = await collection.aggregate<{ readonly count: number }>(
    [...pipeline],
  ).toArray();
  return rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length !== 0) throw new Error('CARE_ALUMNI_CLEANUP_RECONCILE_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('CARE_ALUMNI_CLEANUP_RECONCILE_MONGODB_URI_REQUIRED');
  }
  const targets = parseCareAlumniCleanupTargets(
    process.env.CARE_ALUMNI_CLEANUP_TARGETS_JSON ?? '[]',
  );
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    process.stdout.write(`${JSON.stringify(await reconcileCareAlumniCleanup(
      connection,
      targets,
    ))}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^CARE_ALUMNI_CLEANUP_RECONCILE_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'CARE_ALUMNI_CLEANUP_RECONCILE_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
