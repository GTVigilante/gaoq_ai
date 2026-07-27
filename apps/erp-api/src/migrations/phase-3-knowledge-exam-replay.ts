import { pathToFileURL } from 'node:url';

import { createEventId } from '@gaoq/shared-utils';
import { createConnection, type ClientSession, type Connection } from 'mongoose';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{7,63}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const QUESTION_MODES = ['objective', 'subjective', 'mixed'] as const;

export type KnowledgeExamReplayMode = 'dry-run' | 'apply';

export interface KnowledgeExamReplayCommand {
  readonly uri: string;
  readonly mode: KnowledgeExamReplayMode;
  readonly input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedVersion: number;
    readonly reasonCode: string;
  };
}

export interface KnowledgeExamReplayResult {
  readonly tenantId: string;
  readonly runId: string;
  readonly previousVersion: number;
  readonly version: number;
  readonly status: ReturnType<typeof inferReplayStatus>;
  readonly replayedAt: string;
  readonly applied: boolean;
}

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

export function parseKnowledgeExamReplayCommand(
  argv: readonly string[],
  environment: Readonly<{ readonly MONGODB_URI?: string }>,
): KnowledgeExamReplayCommand {
  const args = argv.filter((argument) => argument !== '--');
  const modeFlags = args.filter((argument) =>
    argument === '--dry-run' || argument === '--apply',
  );
  if (modeFlags.length !== 1) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
  }
  const mode: KnowledgeExamReplayMode =
    modeFlags[0] === '--apply' ? 'apply' : 'dry-run';
  const filtered = args.filter((argument) =>
    argument !== '--dry-run' && argument !== '--apply',
  );
  const allowed = new Set([
    '--tenant-id',
    '--run-id',
    '--expected-version',
    '--reason-code',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < filtered.length; index += 2) {
    const key = filtered[index];
    const value = filtered[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      values.has(key)
    ) {
      throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
    }
    values.set(key, value);
  }
  const tenantId = values.get('--tenant-id');
  const runId = values.get('--run-id');
  const expectedVersion = values.get('--expected-version');
  const reasonCode = values.get('--reason-code');
  const parsedExpectedVersion = Number(expectedVersion);
  if (
    values.size !== allowed.size ||
    tenantId === undefined ||
    runId === undefined ||
    expectedVersion === undefined ||
    reasonCode === undefined ||
    !POSITIVE_INTEGER.test(expectedVersion) ||
    !Number.isSafeInteger(parsedExpectedVersion)
  ) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_ARGUMENT_INVALID');
  }
  const uri = environment.MONGODB_URI;
  if (uri === undefined || !uri.startsWith('mongodb://')) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_MONGODB_URI_REQUIRED');
  }
  return Object.freeze({
    uri,
    mode,
    input: Object.freeze({
      tenantId,
      runId,
      expectedVersion: parsedExpectedVersion,
      reasonCode,
    }),
  });
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
): Promise<KnowledgeExamReplayResult> {
  if (
    !SAFE_ID.test(input.tenantId) ||
    !ULID.test(input.runId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !REASON_CODE.test(input.reasonCode)
  ) throw new Error('KNOWLEDGE_EXAM_REPLAY_INPUT_INVALID');
  const runs = connection.collection('knowledge_exam_runs');
  const session = await connection.startSession();
  let result: KnowledgeExamReplayResult | null = null;
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
      const facts = readReplayFacts(current);
      const status = inferReplayStatus({
        gatewaySessionRef: facts.gatewaySessionRef,
        submissionRef: facts.submissionRef,
        reviewEvidenceId: facts.reviewEvidenceId,
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
            replayReason: input.reasonCode,
            replayedAt: now,
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
        assignmentId: facts.assignmentId,
        courseVersionId: facts.courseVersionId,
        attemptNumber: facts.attemptNumber,
        questionMode: facts.questionMode,
        status,
        timedOut: facts.timedOut,
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

export async function runKnowledgeExamReplayCli(
  argv: readonly string[],
  environment: Readonly<{ readonly MONGODB_URI?: string }>,
  dependencies: {
    readonly connect?: (uri: string) => Connection;
    readonly writeOutput?: (output: string) => void;
  } = {},
): Promise<void> {
  const command = parseKnowledgeExamReplayCommand(argv, environment);
  const connection = dependencies.connect?.(command.uri) ?? createConnection(command.uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await connection.asPromise();
    const output = `${JSON.stringify(await replayKnowledgeExamRun(
      connection,
      command.input,
      command.mode,
    ))}\n`;
    if (dependencies.writeOutput === undefined) process.stdout.write(output);
    else dependencies.writeOutput(output);
  } finally {
    await connection.close();
  }
}

export function knowledgeExamReplayErrorCode(error: unknown): string {
  return error instanceof Error &&
    /^KNOWLEDGE_EXAM_REPLAY_[A-Z_]{1,96}$/.test(error.message)
    ? error.message
    : 'KNOWLEDGE_EXAM_REPLAY_DATABASE_FAILURE';
}

function readReplayFacts(current: Record<string, unknown>): {
  readonly assignmentId: string;
  readonly courseVersionId: string;
  readonly attemptNumber: number;
  readonly questionMode: typeof QUESTION_MODES[number];
  readonly gatewaySessionRef: string | null;
  readonly submissionRef: string | null;
  readonly reviewEvidenceId: string | null;
  readonly timedOut: boolean;
} {
  const assignmentId = readRequiredId(current.assignmentId);
  const courseVersionId = readRequiredId(current.courseVersionId);
  const attemptNumber = current.attemptNumber;
  const maxAttempts = current.maxAttempts;
  const questionMode = current.questionMode;
  const manualReviewRequired = current.manualReviewRequired;
  const gatewaySessionRef = readNullableId(current.gatewaySessionRef);
  const submissionRef = readNullableId(current.submissionRef);
  const questionSetDigest = readNullableDigest(current.questionSetDigest);
  const reviewEvidenceId = readNullableId(current.reviewEvidenceId);
  const finalAttemptId = readNullableId(current.finalAttemptId);
  const startedAt = readNullableDate(current.startedAt);
  const deadlineAt = readNullableDate(current.deadlineAt);
  const submittedAt = readNullableDate(current.submittedAt);
  const submissionReason = current.submissionReason;
  const timedOut = current.timedOut;
  const hasGatewaySession = gatewaySessionRef !== null;
  const hasSubmission = submissionRef !== null;
  if (
    assignmentId === null ||
    courseVersionId === null ||
    !Number.isSafeInteger(attemptNumber) ||
    Number(attemptNumber) < 1 ||
    !Number.isSafeInteger(maxAttempts) ||
    Number(maxAttempts) < 1 ||
    Number(maxAttempts) > 10 ||
    Number(attemptNumber) > Number(maxAttempts) ||
    !QUESTION_MODES.includes(questionMode as typeof QUESTION_MODES[number]) ||
    typeof manualReviewRequired !== 'boolean' ||
    manualReviewRequired !== (questionMode !== 'objective') ||
    typeof timedOut !== 'boolean' ||
    hasGatewaySession !== (questionSetDigest !== null) ||
    hasGatewaySession !== (startedAt !== null) ||
    hasGatewaySession !== (deadlineAt !== null) ||
    (startedAt !== null &&
      deadlineAt !== null &&
      deadlineAt.getTime() <= startedAt.getTime()) ||
    (gatewaySessionRef === null && submissionRef !== null) ||
    hasSubmission !== (submittedAt !== null) ||
    hasSubmission !==
      (submissionReason === 'learner' || submissionReason === 'timeout') ||
    timedOut !== (submissionReason === 'timeout') ||
    (submissionRef === null && reviewEvidenceId !== null) ||
    (timedOut &&
      submittedAt !== null &&
      deadlineAt !== null &&
      submittedAt.getTime() !== deadlineAt.getTime()) ||
    (reviewEvidenceId !== null && !manualReviewRequired) ||
    finalAttemptId !== null
  ) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
  }
  return Object.freeze({
    assignmentId,
    courseVersionId,
    attemptNumber: Number(attemptNumber),
    questionMode: questionMode as typeof QUESTION_MODES[number],
    gatewaySessionRef,
    submissionRef,
    reviewEvidenceId,
    timedOut,
  });
}

function readRequiredId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function readNullableId(value: unknown): string | null {
  if (value === null) return null;
  const id = readRequiredId(value);
  if (id === null) throw new Error('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
  return id;
}

function readNullableDigest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
  }
  return value;
}

function readNullableDate(value: unknown): Date | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('KNOWLEDGE_EXAM_REPLAY_RECORD_INVALID');
  }
  return value;
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
  void runKnowledgeExamReplayCli(process.argv.slice(2), process.env).catch(
    (error: unknown) => {
      process.stderr.write(`${knowledgeExamReplayErrorCode(error)}\n`);
      process.exitCode = 1;
    },
  );
}
