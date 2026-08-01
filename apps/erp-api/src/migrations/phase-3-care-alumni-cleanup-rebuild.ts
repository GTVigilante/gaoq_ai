import { pathToFileURL } from 'node:url';

import { createEventId } from '@gaoq/shared-utils';
import { createConnection, type ClientSession, type Connection } from 'mongoose';

import { parseCareAlumniCleanupTargets } from '../config/care-alumni-cleanup-targets.js';

export type CareAlumniCleanupRebuildMode = 'dry-run' | 'apply';

interface TerminalConsentRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly careCaseId: string;
  readonly purpose: 'alumni_network' | 'rehire_contact' | 'alumni_events';
  readonly channels: readonly string[];
  readonly expiresAt: Date;
  readonly withdrawnAt: Date | null;
  readonly expiredAt: Date | null;
  readonly status: 'withdrawn' | 'expired';
  readonly version: number;
}

/** 从权威终态授权重建缺失/已死的原始 Outbox，仍由运行时 relay 统一扇出。 */
export async function rebuildCareAlumniCleanupSourceEvents(
  connection: Connection,
  mode: CareAlumniCleanupRebuildMode,
  targets: readonly { readonly targetCode: string; readonly policyVersion: string }[],
) {
  if (targets.length === 0) {
    throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_TARGETS_REQUIRED');
  }
  const consents = await connection.collection<TerminalConsentRecord>(
    'care_alumni_consents',
  ).find(
    { status: { $in: ['withdrawn', 'expired'] } },
    {
      projection: {
        _id: 0,
        tenantId: 1,
        id: 1,
        careCaseId: 1,
        purpose: 1,
        channels: 1,
        expiresAt: 1,
        withdrawnAt: 1,
        expiredAt: 1,
        status: 1,
        version: 1,
      },
    },
  ).sort({ tenantId: 1, id: 1 }).toArray();
  let missingCoverage = 0;
  let recreatedEvents = 0;
  let resetEvents = 0;
  for (const consent of consents) {
    const coverage = await connection.collection('care_alumni_cleanup_tasks')
      .countDocuments({
        tenantId: consent.tenantId,
        consentId: consent.id,
        consentVersion: consent.version,
        consentPurpose: consent.purpose,
        $or: targets.map((target) => ({
          targetCode: target.targetCode,
          policyVersion: target.policyVersion,
        })),
      });
    if (coverage === targets.length) continue;
    missingCoverage += 1;
    if (mode === 'dry-run') continue;
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        const eventType =
          `cn.gaoq.erp.care.alumni_consent.${consent.status}.v1`;
        const source = connection.collection('integration_outbox');
        const existing = await source.findOne({
          tenantId: consent.tenantId,
          aggregateType: 'care',
          aggregateId: consent.id,
          aggregateVersion: consent.version,
          eventType,
        }, { session });
        if (
          existing !== null &&
          existing.status === 'dispatching' &&
          existing.lockedAt instanceof Date &&
          existing.lockedAt.getTime() > Date.now() - 5 * 60_000
        ) throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_EVENT_IN_FLIGHT');
        if (existing === null) {
          await appendTerminationEvent(connection, session, consent, eventType);
          recreatedEvents += 1;
        } else {
          const updated = await source.updateOne(
            { eventId: existing.eventId },
            { $set: {
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              dispatchedAt: null,
              lastErrorCode: null,
              updatedAt: new Date(),
            } },
            { session },
          );
          if (updated.modifiedCount !== 1) {
            throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_STATE_CONFLICT');
          }
          resetEvents += 1;
        }
      });
    } finally {
      await session.endSession();
    }
  }
  return Object.freeze({
    mode,
    registeredTargetCount: targets.length,
    checkedTerminalConsents: consents.length,
    missingCoverage,
    recreatedEvents,
    resetEvents,
    applied: mode === 'apply',
  });
}

async function appendTerminationEvent(
  connection: Connection,
  session: ClientSession,
  consent: TerminalConsentRecord,
  eventType: string,
): Promise<void> {
  const occurredAt = consent.status === 'withdrawn'
    ? consent.withdrawnAt
    : consent.expiredAt;
  if (!(occurredAt instanceof Date)) {
    throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_TERMINAL_TIME_INVALID');
  }
  const eventId = createEventId(occurredAt);
  const time = occurredAt.toISOString();
  await connection.collection('integration_outbox').insertOne({
    eventId,
    tenantId: consent.tenantId,
    aggregateType: 'care',
    aggregateId: consent.id,
    aggregateVersion: consent.version,
    eventType,
    envelope: {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/care-module',
      type: eventType,
      subject: `tenant/${consent.tenantId}/care/${consent.id}`,
      time,
      datacontenttype: 'application/json',
      tenantId: consent.tenantId,
      traceId: `care-alumni-cleanup-rebuild-${eventId}`,
      idempotencyKey:
        `${consent.tenantId}:${eventType}:${consent.id}:${consent.version}`,
      schemaVersion: '1',
      data: {
        tenantId: consent.tenantId,
        aggregateId: consent.id,
        version: consent.version,
        careCaseId: consent.careCaseId,
        purpose: consent.purpose,
        channels: consent.channels,
        status: consent.status,
        expiresAt: consent.expiresAt.toISOString(),
      },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: occurredAt,
    lockedAt: null,
    lockedBy: null,
    dispatchedAt: null,
    lastErrorCode: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }, { session });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (
    args.length !== 1 ||
    (args[0] !== '--dry-run' && args[0] !== '--apply')
  ) throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('CARE_ALUMNI_CLEANUP_REBUILD_MONGODB_URI_REQUIRED');
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
    process.stdout.write(`${JSON.stringify(
      await rebuildCareAlumniCleanupSourceEvents(
        connection,
        args[0] === '--apply' ? 'apply' : 'dry-run',
        targets,
      ),
    )}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^CARE_ALUMNI_CLEANUP_REBUILD_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'CARE_ALUMNI_CLEANUP_REBUILD_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
