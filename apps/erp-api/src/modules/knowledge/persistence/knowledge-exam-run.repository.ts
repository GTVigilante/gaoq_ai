import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { KnowledgeExamRun } from '../domain/index.js';
import {
  KnowledgeExamRunRecord,
  type KnowledgeExamRunDocument,
} from './knowledge-exam-run.schemas.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/u;
const REPLAY_REASON_PATTERN = /^[A-Z][A-Z0-9_]{7,63}$/u;
const ACTIVE_STATUSES = Object.freeze([
  'starting',
  'in_progress',
  'submitted',
  'pending_review',
] as const);
const EXAM_RUN_PROJECTION = [
  'id', 'tenantId', 'assignmentId', 'courseVersionId', 'questionBankRef',
  'questionBankDigest', 'attemptNumber', 'questionMode', 'gradingPolicyVersion',
  'passingRule', 'passingScoreBps', 'maxAttempts', 'timeLimitMinutes',
  'manualReviewRequired', 'gradingSlaMinutes', 'manualReviewSlaMinutes', 'status',
  'gatewaySessionRef', 'submissionRef', 'questionSetDigest', 'reviewEvidenceId',
  'finalAttemptId', 'startedAt', 'deadlineAt', 'submittedAt', 'submissionReason',
  'timedOut', 'attempts', 'reviewPolls', 'nextActionAt', 'lastErrorCode', 'lockedAt',
  'lockedBy', 'replayReason', 'replayedAt', 'version', 'createdAt', 'updatedAt',
  '-_id',
].join(' ');

const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const digestSchema = z.string().regex(DIGEST_PATTERN);
const validDateSchema = z.date().refine((value) => Number.isFinite(value.getTime()));
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const questionModeSchema = z.enum(['objective', 'subjective', 'mixed']);
const statusSchema = z.enum([
  'starting',
  'in_progress',
  'submitted',
  'pending_review',
  'graded',
  'dead',
]);
const submissionReasonSchema = z.enum(['learner', 'timeout']).nullable();

const runScalarSchemas = {
  id: safeIdSchema,
  tenantId: safeIdSchema,
  assignmentId: safeIdSchema,
  courseVersionId: safeIdSchema,
  questionBankRef: safeIdSchema,
  questionBankDigest: digestSchema,
  attemptNumber: z.number().int().min(1).max(10),
  questionMode: questionModeSchema,
  gradingPolicyVersion: z.string().regex(POLICY_VERSION_PATTERN),
  passingRule: z.enum(['score_threshold', 'all_required_sections']),
  passingScoreBps: z.number().int().min(0).max(10_000),
  maxAttempts: z.number().int().min(1).max(10),
  timeLimitMinutes: z.number().int().min(5).max(240),
  manualReviewRequired: z.boolean(),
  gradingSlaMinutes: z.number().int().min(1).max(60),
  manualReviewSlaMinutes: z.number().int().min(30).max(10_080),
  status: statusSchema,
  gatewaySessionRef: safeIdSchema.nullable(),
  submissionRef: safeIdSchema.nullable(),
  questionSetDigest: digestSchema.nullable(),
  reviewEvidenceId: safeIdSchema.nullable(),
  finalAttemptId: safeIdSchema.nullable(),
  submissionReason: submissionReasonSchema,
  timedOut: z.boolean(),
  attempts: z.number().int().min(0).max(8),
  reviewPolls: z.number().int().min(0).max(100_000),
  lastErrorCode: z.string().regex(ERROR_CODE_PATTERN).nullable(),
  version: positiveIntegerSchema,
} as const;

const domainRunSchema = z.object({
  ...runScalarSchemas,
  startedAt: canonicalInstantSchema.nullable(),
  deadlineAt: canonicalInstantSchema.nullable(),
  submittedAt: canonicalInstantSchema.nullable(),
  nextActionAt: canonicalInstantSchema,
  createdAt: canonicalInstantSchema,
  updatedAt: canonicalInstantSchema,
}).strict().superRefine((value, context) => {
  validateRunState(value, (message) => {
    context.addIssue({ code: 'custom', message });
  });
});

const recordRunSchema = z.object({
  ...runScalarSchemas,
  startedAt: validDateSchema.nullable(),
  deadlineAt: validDateSchema.nullable(),
  submittedAt: validDateSchema.nullable(),
  nextActionAt: validDateSchema,
  lockedAt: validDateSchema.nullable(),
  lockedBy: safeIdSchema.nullable(),
  replayReason: z.string().regex(REPLAY_REASON_PATTERN).nullable(),
  replayedAt: validDateSchema.nullable(),
  createdAt: validDateSchema,
  updatedAt: validDateSchema,
}).superRefine((value, context) => {
  validateRunState(value, (message) => {
    context.addIssue({ code: 'custom', message });
  });
  if ((value.lockedAt === null) !== (value.lockedBy === null)) {
    context.addIssue({ code: 'custom', message: 'lock_evidence_invalid' });
  }
  if ((value.replayReason === null) !== (value.replayedAt === null)) {
    context.addIssue({ code: 'custom', message: 'replay_evidence_invalid' });
  }
});

/** Knowledge 考试运行仓储；所有读取投影和事务写入均执行运行时反向绑定。 */
@Injectable()
export class KnowledgeExamRunRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(KnowledgeExamRunRecord.name)
    private readonly records: Model<KnowledgeExamRunDocument>,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<KnowledgeExamRun | null> {
    const tenantId = this.tenantId();
    assertSafeId(id);
    const query = this.records.findOne({ tenantId, id }).select(EXAM_RUN_PROJECTION);
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    if (value === null) return null;
    const run = parseRecord(value);
    assertRecordBinding(run, { tenantId, id });
    return toDomain(run);
  }

  async findActiveByAssignment(
    assignmentId: string,
    session?: ClientSession,
  ): Promise<KnowledgeExamRun | null> {
    const tenantId = this.tenantId();
    assertSafeId(assignmentId);
    const query = this.records.findOne({
      tenantId,
      assignmentId,
      status: { $in: [...ACTIVE_STATUSES] },
    }).select(EXAM_RUN_PROJECTION);
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    if (value === null) return null;
    const run = parseRecord(value);
    assertRecordBinding(run, { tenantId, assignmentId });
    if (!ACTIVE_STATUSES.includes(run.status as typeof ACTIVE_STATUSES[number])) {
      throw new Error('KNOWLEDGE_EXAM_RUN_RECORD_INVALID');
    }
    return toDomain(run);
  }

  async nextAttemptNumber(assignmentId: string, session: ClientSession): Promise<number> {
    const tenantId = this.tenantId();
    assertSafeId(assignmentId);
    requireActiveTransaction(session);
    const value = await this.records.findOne({ tenantId, assignmentId })
      .select('tenantId assignmentId attemptNumber -_id')
      .sort({ attemptNumber: -1 }).session(session).lean().exec();
    if (value === null) return 1;
    const parsed = z.object({
      tenantId: safeIdSchema,
      assignmentId: safeIdSchema,
      attemptNumber: z.number().int().min(1).max(10),
    }).safeParse(value);
    if (
      !parsed.success ||
      parsed.data.tenantId !== tenantId ||
      parsed.data.assignmentId !== assignmentId
    ) throw new Error('KNOWLEDGE_EXAM_RUN_RECORD_INVALID');
    return parsed.data.attemptNumber + 1;
  }

  async insert(run: KnowledgeExamRun, session: ClientSession): Promise<void> {
    const tenantId = this.tenantId();
    const canonical = parseDomain(run);
    if (canonical.tenantId !== tenantId) throw new Error('KNOWLEDGE_EXAM_RUN_TENANT_MISMATCH');
    requireActiveTransaction(session);
    const row = {
      ...canonical,
      startedAt: toDate(canonical.startedAt),
      deadlineAt: toDate(canonical.deadlineAt),
      submittedAt: toDate(canonical.submittedAt),
      nextActionAt: new Date(canonical.nextActionAt),
      createdAt: new Date(canonical.createdAt),
      updatedAt: new Date(canonical.updatedAt),
      lockedAt: null,
      lockedBy: null,
      replayReason: null,
      replayedAt: null,
    };
    const created = await this.records.create([row], { session });
    if (!Array.isArray(created) || created.length !== 1) {
      throw new Error('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
    }
    const stored = parseWrittenRecord(asPlainObject(created[0]));
    if (!isDeepStrictEqual(toDomain(stored), canonical)) {
      throw new Error('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
    }
  }

  async submit(
    id: string,
    expectedVersion: number,
    submissionRef: string,
    now: Date,
    session: ClientSession,
  ): Promise<KnowledgeExamRun | null> {
    const tenantId = this.tenantId();
    assertSafeId(id);
    assertSafeId(submissionRef);
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion >= Number.MAX_SAFE_INTEGER ||
      !isValidDate(now)
    ) throw new Error('KNOWLEDGE_EXAM_RUN_INPUT_INVALID');
    requireActiveTransaction(session);
    const value = await this.records.findOneAndUpdate(
      {
        tenantId,
        id,
        status: 'in_progress',
        version: expectedVersion,
        deadlineAt: { $gt: now },
      },
      {
        $set: {
          status: 'submitted',
          submissionRef,
          submittedAt: now,
          submissionReason: 'learner',
          timedOut: false,
          nextActionAt: now,
          lastErrorCode: null,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', timestamps: false, runValidators: true },
    ).select(EXAM_RUN_PROJECTION).lean().exec();
    if (value === null) return null;
    const run = parseWrittenRecord(value);
    assertRecordBinding(
      run,
      { tenantId, id },
      'KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE',
    );
    if (
      run.status !== 'submitted' ||
      run.version !== expectedVersion + 1 ||
      run.submissionRef !== submissionRef ||
      run.submissionReason !== 'learner' ||
      run.timedOut ||
      run.submittedAt?.getTime() !== now.getTime() ||
      run.nextActionAt.getTime() !== now.getTime() ||
      run.updatedAt.getTime() !== now.getTime()
    ) throw new Error('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
    return toDomain(run);
  }

  private tenantId(): string {
    let trusted: unknown;
    try {
      trusted = this.context.getTenantRequired();
    } catch {
      throw new Error('KNOWLEDGE_EXAM_RUN_CONTEXT_INVALID');
    }
    const parsed = z.object({ tenantId: safeIdSchema }).passthrough().safeParse(trusted);
    if (!parsed.success) throw new Error('KNOWLEDGE_EXAM_RUN_CONTEXT_INVALID');
    return parsed.data.tenantId;
  }
}

function toDomain(value: z.infer<typeof recordRunSchema>): KnowledgeExamRun {
  return deepFreeze({
    id: value.id,
    tenantId: value.tenantId,
    assignmentId: value.assignmentId,
    courseVersionId: value.courseVersionId,
    questionBankRef: value.questionBankRef,
    questionBankDigest: value.questionBankDigest,
    attemptNumber: value.attemptNumber,
    questionMode: value.questionMode,
    gradingPolicyVersion: value.gradingPolicyVersion,
    passingRule: value.passingRule,
    passingScoreBps: value.passingScoreBps,
    maxAttempts: value.maxAttempts,
    timeLimitMinutes: value.timeLimitMinutes,
    manualReviewRequired: value.manualReviewRequired,
    gradingSlaMinutes: value.gradingSlaMinutes,
    manualReviewSlaMinutes: value.manualReviewSlaMinutes,
    status: value.status,
    gatewaySessionRef: value.gatewaySessionRef,
    submissionRef: value.submissionRef,
    questionSetDigest: value.questionSetDigest,
    reviewEvidenceId: value.reviewEvidenceId,
    finalAttemptId: value.finalAttemptId,
    startedAt: value.startedAt?.toISOString() ?? null,
    deadlineAt: value.deadlineAt?.toISOString() ?? null,
    submittedAt: value.submittedAt?.toISOString() ?? null,
    submissionReason: value.submissionReason,
    timedOut: value.timedOut,
    attempts: value.attempts,
    reviewPolls: value.reviewPolls,
    nextActionAt: value.nextActionAt.toISOString(),
    lastErrorCode: value.lastErrorCode,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function parseDomain(value: unknown): KnowledgeExamRun {
  const parsed = domainRunSchema.safeParse(value);
  if (!parsed.success) throw new Error('KNOWLEDGE_EXAM_RUN_INPUT_INVALID');
  return deepFreeze(parsed.data);
}

function parseRecord(value: unknown): z.infer<typeof recordRunSchema> {
  const parsed = recordRunSchema.safeParse(value);
  if (!parsed.success) throw new Error('KNOWLEDGE_EXAM_RUN_RECORD_INVALID');
  return parsed.data;
}

function parseWrittenRecord(value: unknown): z.infer<typeof recordRunSchema> {
  try {
    return parseRecord(value);
  } catch {
    throw new Error('KNOWLEDGE_EXAM_RUN_WRITE_UNAVAILABLE');
  }
}

function assertSafeId(value: unknown): asserts value is string {
  if (!safeIdSchema.safeParse(value).success) {
    throw new Error('KNOWLEDGE_EXAM_RUN_INPUT_INVALID');
  }
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('KNOWLEDGE_EXAM_RUN_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('KNOWLEDGE_EXAM_RUN_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('KNOWLEDGE_EXAM_RUN_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('KNOWLEDGE_EXAM_RUN_TRANSACTION_REQUIRED');
}

function assertRecordBinding(
  run: z.infer<typeof recordRunSchema>,
  expected: {
    readonly tenantId: string;
    readonly id?: string;
    readonly assignmentId?: string;
  },
  errorCode = 'KNOWLEDGE_EXAM_RUN_RECORD_INVALID',
): void {
  if (
    run.tenantId !== expected.tenantId ||
    (expected.id !== undefined && run.id !== expected.id) ||
    (expected.assignmentId !== undefined && run.assignmentId !== expected.assignmentId)
  ) throw new Error(errorCode);
}

function validateRunState(
  value: {
    readonly attemptNumber: number;
    readonly maxAttempts: number;
    readonly timeLimitMinutes: number;
    readonly questionMode: 'objective' | 'subjective' | 'mixed';
    readonly manualReviewRequired: boolean;
    readonly status: z.infer<typeof statusSchema>;
    readonly gatewaySessionRef: string | null;
    readonly questionSetDigest: string | null;
    readonly submissionRef: string | null;
    readonly reviewEvidenceId: string | null;
    readonly finalAttemptId: string | null;
    readonly startedAt: Date | string | null;
    readonly deadlineAt: Date | string | null;
    readonly submittedAt: Date | string | null;
    readonly submissionReason: 'learner' | 'timeout' | null;
    readonly timedOut: boolean;
    readonly createdAt: Date | string;
    readonly updatedAt: Date | string;
    readonly nextActionAt: Date | string;
  },
  issue: (message: string) => void,
): void {
  const startedAt = timestamp(value.startedAt);
  const deadlineAt = timestamp(value.deadlineAt);
  const submittedAt = timestamp(value.submittedAt);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const nextActionAt = timestamp(value.nextActionAt);
  const hasGatewayEvidence =
    value.gatewaySessionRef !== null &&
    value.questionSetDigest !== null &&
    startedAt !== null &&
    deadlineAt !== null;
  const hasAnyGatewayEvidence =
    value.gatewaySessionRef !== null ||
    value.questionSetDigest !== null ||
    startedAt !== null ||
    deadlineAt !== null;
  const hasSubmission =
    value.submissionRef !== null &&
    submittedAt !== null &&
    value.submissionReason !== null;
  const hasAnySubmission =
    value.submissionRef !== null ||
    submittedAt !== null ||
    value.submissionReason !== null;

  if (
    value.attemptNumber > value.maxAttempts ||
    value.manualReviewRequired !== (value.questionMode !== 'objective')
  ) issue('policy_invalid');
  if (
    updatedAt === null ||
    createdAt === null ||
    nextActionAt === null ||
    updatedAt < createdAt ||
    nextActionAt < createdAt
  ) issue('timeline_invalid');
  if (hasAnyGatewayEvidence !== hasGatewayEvidence) issue('gateway_evidence_invalid');
  if (hasAnySubmission !== hasSubmission) issue('submission_evidence_invalid');
  if (value.timedOut !== (value.submissionReason === 'timeout')) issue('timeout_invalid');
  if (
    startedAt !== null &&
    deadlineAt !== null &&
    (
      startedAt < (createdAt ?? startedAt) ||
      deadlineAt - startedAt !== value.timeLimitMinutes * 60_000
    )
  ) issue('deadline_invalid');
  if (
    submittedAt !== null &&
    (
      startedAt === null ||
      deadlineAt === null ||
      submittedAt < startedAt ||
      submittedAt > deadlineAt ||
      (value.timedOut && submittedAt !== deadlineAt)
    )
  ) issue('submitted_at_invalid');
  if (
    value.status === 'starting' &&
    (hasAnyGatewayEvidence || hasAnySubmission || value.reviewEvidenceId !== null ||
      value.finalAttemptId !== null || value.timedOut)
  ) issue('starting_state_invalid');
  if (
    value.status === 'in_progress' &&
    (!hasGatewayEvidence || hasAnySubmission || value.reviewEvidenceId !== null ||
      value.finalAttemptId !== null || value.timedOut)
  ) issue('in_progress_state_invalid');
  if (
    ['submitted', 'pending_review', 'graded'].includes(value.status) &&
    (!hasGatewayEvidence || !hasSubmission)
  ) issue('submitted_state_invalid');
  if (
    value.status === 'submitted' &&
    (value.reviewEvidenceId !== null || value.finalAttemptId !== null)
  ) issue('submitted_terminal_evidence_invalid');
  if (
    value.status === 'pending_review' &&
    (
      !value.manualReviewRequired ||
      value.reviewEvidenceId === null ||
      value.finalAttemptId !== null
    )
  ) issue('review_state_invalid');
  if (
    value.status === 'graded' &&
    (
      value.finalAttemptId === null ||
      (value.manualReviewRequired && value.reviewEvidenceId === null) ||
      (!value.manualReviewRequired && value.reviewEvidenceId !== null)
    )
  ) issue('graded_state_invalid');
  if (value.status !== 'graded' && value.finalAttemptId !== null) {
    issue('non_graded_final_attempt_invalid');
  }
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
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
