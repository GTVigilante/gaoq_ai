import { pathToFileURL } from 'node:url';

import { createEventId } from '@gaoq/shared-utils';
import { createConnection, type ClientSession, type Connection } from 'mongoose';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{7,63}$/u;

export type CareOccasionReplayMode = 'dry-run' | 'apply';
export interface CareOccasionReplayResult {
  readonly tenantId: string;
  readonly taskId: string;
  readonly previousVersion: number;
  readonly version: number;
  readonly status: 'pending';
  readonly replayedAt: string;
  readonly applied: boolean;
}

export async function replayCareOccasionTask(
  connection: Connection,
  input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly reasonCode: string;
  },
  mode: CareOccasionReplayMode,
): Promise<CareOccasionReplayResult> {
  if (
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_ID.test(input.taskId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !REASON_CODE.test(input.reasonCode)
  ) throw new Error('CARE_OCCASION_REPLAY_INPUT_INVALID');
  const tasks = connection.collection('care_occasion_tasks');
  const session = await connection.startSession();
  let result: CareOccasionReplayResult | null = null;
  try {
    await session.withTransaction(async () => {
      const current = await tasks.findOne({
        tenantId: input.tenantId,
        id: input.taskId,
        status: 'dead',
        version: input.expectedVersion,
        lockedAt: null,
        lockedBy: null,
      }, { session });
      if (current === null) throw new Error('CARE_OCCASION_REPLAY_STATE_CONFLICT');
      if (
        !['birthday', 'employment_anniversary'].includes(String(current.occasionType)) ||
        !SAFE_ID.test(String(current.policyVersion))
      ) throw new Error('CARE_OCCASION_REPLAY_RECORD_INVALID');
      const now = new Date();
      result = Object.freeze({
        tenantId: input.tenantId,
        taskId: input.taskId,
        previousVersion: input.expectedVersion,
        version: input.expectedVersion + 1,
        status: 'pending',
        replayedAt: now.toISOString(),
        applied: mode === 'apply',
      });
      if (mode === 'dry-run') return;
      const updated = await tasks.updateOne(
        {
          tenantId: input.tenantId,
          id: input.taskId,
          status: 'dead',
          version: input.expectedVersion,
          lockedAt: null,
          lockedBy: null,
        },
        {
          $set: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedAt: null,
            lockedBy: null,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error('CARE_OCCASION_REPLAY_STATE_CONFLICT');
      }
      await appendReplayEvent(connection, session, {
        tenantId: input.tenantId,
        taskId: input.taskId,
        occasionType: String(current.occasionType),
        policyVersion: String(current.policyVersion),
        version: input.expectedVersion + 1,
        reasonCode: input.reasonCode,
        occurredAt: now,
      });
    });
  } finally {
    await session.endSession();
  }
  const finalized = result as CareOccasionReplayResult | null;
  if (finalized === null) throw new Error('CARE_OCCASION_REPLAY_STATE_CONFLICT');
  return finalized;
}

async function appendReplayEvent(
  connection: Connection,
  session: ClientSession,
  input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly occasionType: string;
    readonly policyVersion: string;
    readonly version: number;
    readonly reasonCode: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const eventId = createEventId(input.occurredAt);
  const eventType = 'cn.gaoq.erp.care.occasion.replayed.v1';
  const occurredAt = input.occurredAt.toISOString();
  await connection.collection('integration_outbox').insertOne({
    eventId,
    tenantId: input.tenantId,
    aggregateType: 'care',
    aggregateId: input.taskId,
    aggregateVersion: input.version,
    eventType,
    envelope: {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/care-module',
      type: eventType,
      subject: `tenant/${input.tenantId}/care/${input.taskId}`,
      time: occurredAt,
      datacontenttype: 'application/json',
      tenantId: input.tenantId,
      traceId: `care-occasion-replay-${eventId}`,
      idempotencyKey:
        `${input.tenantId}:${eventType}:${input.taskId}:${input.version}`,
      schemaVersion: '1',
      data: {
        tenantId: input.tenantId,
        aggregateId: input.taskId,
        version: input.version,
        purpose: 'employee_care',
        occasionType: input.occasionType,
        policyVersion: input.policyVersion,
        status: 'pending',
        attempts: 0,
        reasonCode: input.reasonCode,
      },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: input.occurredAt,
    lockedAt: null,
    lockedBy: null,
    dispatchedAt: null,
    deadAt: null,
    lastErrorCode: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  }, { session });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const modeFlags = args.filter((argument) =>
    argument === '--dry-run' || argument === '--apply',
  );
  if (modeFlags.length !== 1) throw new Error('CARE_OCCASION_REPLAY_ARGUMENT_INVALID');
  const mode: CareOccasionReplayMode =
    modeFlags[0] === '--apply' ? 'apply' : 'dry-run';
  const filtered = args.filter((argument) =>
    argument !== '--dry-run' && argument !== '--apply',
  );
  const values = new Map<string, string>();
  for (let index = 0; index < filtered.length; index += 2) {
    const key = filtered[index];
    const value = filtered[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('CARE_OCCASION_REPLAY_ARGUMENT_INVALID');
    }
    values.set(key, value);
  }
  if (
    values.size !== 4 ||
    !values.has('--tenant-id') ||
    !values.has('--task-id') ||
    !values.has('--expected-version') ||
    !values.has('--reason-code')
  ) throw new Error('CARE_OCCASION_REPLAY_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('CARE_OCCASION_REPLAY_MONGODB_URI_REQUIRED');
  }
  const tenantId = values.get('--tenant-id');
  const taskId = values.get('--task-id');
  const reasonCode = values.get('--reason-code');
  if (tenantId === undefined || taskId === undefined || reasonCode === undefined) {
    throw new Error('CARE_OCCASION_REPLAY_ARGUMENT_INVALID');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const result = await replayCareOccasionTask(connection, {
      tenantId,
      taskId,
      expectedVersion: Number(values.get('--expected-version')),
      reasonCode,
    }, mode);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection.close();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^CARE_OCCASION_REPLAY_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'CARE_OCCASION_REPLAY_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
