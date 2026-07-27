import { pathToFileURL } from 'node:url';

import { createEventId } from '@gaoq/shared-utils';
import { createConnection, type ClientSession, type Connection } from 'mongoose';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{7,63}$/u;

export type KnowledgeExamReplayMode = 'dry-run' | 'apply';

export function inferReplayStatus(run: {
  readonly gatewaySessionRef: string | null;
  readonly submissionRef: string | null;
  readonly reviewEvidenceId: string | null;
}): 'starting' | 'in_progress' | 'submitted' | 'pending_review' {
  if (run.gatewaySessionRef === null) return 'starting';
  if (run.submissionRef === null) return 'in_progress';
  if (run.reviewEvidenceId !== null) return 'pending_review';
  return 'submitted';
}

export async function replayKnowledgeExamRun(
  connection: Connection,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedVersion: number;
    readonly reasonCode: string;
  },
  mode: KnowledgeExamReplayMode,
) {
  if (
    !SAFE_ID.test(input.tenantId) ||
    !ULID.test(input.runId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !REASON_CODE.test(input.reasonCode)
  ) throw new Error('KNOWLEDGE_EXAM_REPLAY_INPUT_INVALID');
  const runs = connection.collection('knowledge_exam_runs');
  const session = await connection.startSession();
  let result: {
    readonly tenantId: string;
    readonly runId: string;
    readonly previousVersion: number;
    readonly version: number;
    readonly status: ReturnType<typeof inferReplayStatus>;
    readonly replayedAt: string;
    readonly applied: boolean;
  } | null = null;
  try {
    await session.withTransaction(async () => {
      const current = await runs.findOne({
        tenantId: input.tenantId,
        id: input.runId,
        status: 'dead',
        version: input.expectedVersion,
        lockedAt: null,
        lockedBy: null,
      }, { session });
      if (current === null) throw new Error('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
      const status = inferReplayStatus({
        gatewaySessionRef: typeof current.gatewaySessionRef === 'string'
          ? current.gatewaySessionRef
          : null,
        submissionRef: typeof current.submissionRef === 'string'
          ? current.submissionRef
          : null,
        reviewEvidenceId: typeof current.reviewEvidenceId === 'string'
          ? current.reviewEvidenceId
          : null,
      });
      const now = new Date();
      result = Object.freeze({
        tenantId: input.tenantId,
        runId: input.runId,
        previousVersion: input.expectedVersion,
        version: input.expectedVersion + 1,
        status,
        replayedAt: now.toISOString(),
        applied: mode === 'apply',
      });
      if (mode === 'dry-run') return;
      const updated = await runs.updateOne(
        {
          tenantId: input.tenantId,
          id: input.runId,
          status: 'dead',
          version: input.expectedVersion,
          lockedAt: null,
          lockedBy: null,
        },
        {
          $set: {
            status,
            attempts: 0,
            nextActionAt: now,
            lastErrorCode: null,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
      }
      await appendReplayEvent(connection, session, {
        tenantId: input.tenantId,
        runId: input.runId,
        assignmentId: String(current.assignmentId),
        courseVersionId: String(current.courseVersionId),
        attemptNumber: Number(current.attemptNumber),
        questionMode: String(current.questionMode),
        status,
        timedOut: current.timedOut === true,
        version: input.expectedVersion + 1,
        reasonCode: input.reasonCode,
        occurredAt: now,
      });
    });
  } finally {
    await session.endSession();
  }
  if (result === null) throw new Error('KNOWLEDGE_EXAM_REPLAY_STATE_CONFLICT');
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const modeFlag = args.filter((arg) => arg === '--dry-run' || arg === '--apply');
  if (modeFlag.length !== 1) throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
  const mode: KnowledgeExamReplayMode = modeFlag[0] === '--apply' ? 'apply' : 'dry-run';
  const filtered = args.filter((arg) => arg !== '--dry-run' && arg !== '--apply');
  const values = new Map<string, string>();
  for (let index = 0; index < filtered.length; index += 2) {
    const key = filtered[index];
    const value = filtered[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
    }
    values.set(key, value);
  }
  if (
    values.size !== 4 ||
    !values.has('--tenant-id') ||
    !values.has('--run-id') ||
    !values.has('--expected-version') ||
    !values.has('--reason-code')
  ) throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_MONGODB_URI_REQUIRED');
  }
  const connection = createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const tenantId = values.get('--tenant-id');
    const runId = values.get('--run-id');
    const expectedVersion = Number(values.get('--expected-version'));
    const reasonCode = values.get('--reason-code');
    if (tenantId === undefined || runId === undefined || reasonCode === undefined) {
      throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
    }
    process.stdout.write(`${JSON.stringify(await replayKnowledgeExamRun(connection, {
      tenantId,
      runId,
      expectedVersion,
      reasonCode,
    }, mode))}\n`);
  } finally {
    await connection.close();
  }
}

async function appendReplayEvent(
  connection: Connection,
  session: ClientSession,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly courseVersionId: string;
    readonly attemptNumber: number;
    readonly questionMode: string;
    readonly status: ReturnType<typeof inferReplayStatus>;
    readonly timedOut: boolean;
    readonly version: number;
    readonly reasonCode: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  if (
    !SAFE_ID.test(input.assignmentId) ||
    !SAFE_ID.test(input.courseVersionId) ||
    !Number.isSafeInteger(input.attemptNumber) ||
    !['objective', 'subjective', 'mixed'].includes(input.questionMode)
  ) throw new Error('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
  const eventId = createEventId(input.occurredAt);
  const eventType = 'cn.gaoq.erp.knowledge.exam.run.replayed.v1';
  const time = input.occurredAt.toISOString();
  await connection.collection('integration_outbox').insertOne({
    eventId,
    tenantId: input.tenantId,
    aggregateType: 'knowledge',
    aggregateId: input.runId,
    aggregateVersion: input.version,
    eventType,
    envelope: {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/knowledge-module',
      type: eventType,
      subject: `tenant/${input.tenantId}/knowledge/${input.runId}`,
      time,
      datacontenttype: 'application/json',
      tenantId: input.tenantId,
      traceId: `knowledge-exam-replay:${eventId}`,
      idempotencyKey: `${input.tenantId}:${eventType}:${input.runId}:${input.version}`,
      schemaVersion: '1',
      data: {
        tenantId: input.tenantId,
        aggregateId: input.runId,
        version: input.version,
        assignmentId: input.assignmentId,
        courseVersionId: input.courseVersionId,
        attemptNumber: input.attemptNumber,
        questionMode: input.questionMode,
        status: input.status,
        timedOut: input.timedOut,
        reasonCode: input.reasonCode,
      },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: input.occurredAt,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  }, { session });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^KNOWLEDGE_EXAM_REPLAY_[A-Z_]{1,96}$/.test(error.message)
        ? error.message
        : 'KNOWLEDGE_EXAM_REPLAY_DATABASE_FAILURE';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
