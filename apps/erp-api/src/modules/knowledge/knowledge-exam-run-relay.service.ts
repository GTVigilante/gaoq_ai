import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { MetricsService } from '../../core/observability/metrics.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import {
  KnowledgeExamOrchestrationPort,
  type KnowledgeExamOrchestrationInput,
} from './application/knowledge-ports.js';
import {
  createExamAttempt,
  examGradedEvent,
  type KnowledgeDomainEvent,
} from './domain/index.js';
import {
  KnowledgeExamRunRecord,
  type KnowledgeExamRunDocument,
} from './persistence/knowledge-exam-run.schemas.js';
import {
  KnowledgeExamAttemptRecord,
  type KnowledgeExamAttemptDocument,
} from './persistence/knowledge.schemas.js';
import { KnowledgeOutboxWriter } from './persistence/knowledge-outbox.writer.js';

const LOCK_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

interface ClaimedRun extends KnowledgeExamOrchestrationInput {
  readonly status: 'starting' | 'in_progress' | 'submitted' | 'pending_review';
  readonly passingScoreBps: number;
  readonly gradingSlaMinutes: number;
  readonly manualReviewSlaMinutes: number;
  readonly gatewaySessionRef: string | null;
  readonly submissionRef: string | null;
  readonly questionSetDigest: string | null;
  readonly reviewEvidenceId: string | null;
  readonly startedAt: Date | null;
  readonly deadlineAt: Date | null;
  readonly submittedAt: Date | null;
  readonly submissionReason: 'learner' | 'timeout' | null;
  readonly reviewPolls: number;
  readonly timedOut: boolean;
  readonly attempts: number;
  readonly version: number;
  readonly createdAt: Date;
}

/** 可靠推进考试启动、到时自动提交、自动评分和人工复核轮询。 */
@Injectable()
export class KnowledgeExamRunRelayService {
  private readonly logger = new Logger(KnowledgeExamRunRelayService.name);
  private readonly circuit = new GradingCircuitBreaker();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(KnowledgeExamRunRecord.name)
    private readonly runs: Model<KnowledgeExamRunDocument>,
    @InjectModel(KnowledgeExamAttemptRecord.name)
    private readonly attempts: Model<KnowledgeExamAttemptDocument>,
    private readonly gateway: KnowledgeExamOrchestrationPort,
    private readonly metrics: MetricsService,
    private readonly context: TenantContextService,
    private readonly outbox: KnowledgeOutboxWriter,
    private readonly audit: AuditService,
  ) {}

  async relayBatch(workerId: string, limit = 100): Promise<number> {
    assertWorker(workerId, limit);
    let completed = 0;
    for (let index = 0; index < limit; index += 1) {
      const run = await this.claim(workerId);
      if (run === null) break;
      try {
        this.circuit.beforeRequest();
        await this.advance(workerId, run);
        this.circuit.onSuccess();
        completed += 1;
      } catch (caught) {
        if (caught instanceof Error && caught.message === 'KNOWLEDGE_GRADING_CIRCUIT_OPEN') {
          await this.deferCircuitOpen(workerId, run);
          continue;
        }
        this.circuit.onFailure();
        await this.release(workerId, run, failureCode(caught));
      }
    }
    try {
      await this.refreshMetrics();
    } catch {
      this.logger.warn({ code: 'KNOWLEDGE_EXAM_METRICS_REFRESH_FAILED' });
    }
    return completed;
  }

  private async claim(workerId: string): Promise<ClaimedRun | null> {
    const now = new Date();
    const value = await this.runs.findOneAndUpdate(
      {
        status: { $in: ['starting', 'in_progress', 'submitted', 'pending_review'] },
        nextActionAt: { $lte: now },
        $or: [
          { lockedAt: null },
          { lockedAt: { $lte: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
        ],
      },
      { $set: { lockedAt: now, lockedBy: workerId } },
      {
        sort: { nextActionAt: 1, createdAt: 1 },
        returnDocument: 'after',
        timestamps: false,
      },
    ).lean().exec();
    return value === null ? null : Object.freeze({
      runId: value.id,
      tenantId: value.tenantId,
      assignmentId: value.assignmentId,
      courseVersionId: value.courseVersionId,
      attemptNumber: value.attemptNumber,
      questionBankRef: value.questionBankRef,
      questionBankDigest: value.questionBankDigest,
      questionMode: value.questionMode,
      gradingPolicyVersion: value.gradingPolicyVersion,
      passingRule: value.passingRule,
      timeLimitMinutes: value.timeLimitMinutes,
      manualReviewRequired: value.manualReviewRequired,
      status: value.status as ClaimedRun['status'],
      passingScoreBps: value.passingScoreBps,
      gradingSlaMinutes: value.gradingSlaMinutes,
      manualReviewSlaMinutes: value.manualReviewSlaMinutes,
      gatewaySessionRef: value.gatewaySessionRef,
      submissionRef: value.submissionRef,
      questionSetDigest: value.questionSetDigest,
      reviewEvidenceId: value.reviewEvidenceId,
      startedAt: value.startedAt,
      deadlineAt: value.deadlineAt,
      submittedAt: value.submittedAt,
      submissionReason: value.submissionReason,
      reviewPolls: value.reviewPolls,
      timedOut: value.timedOut,
      attempts: value.attempts,
      version: value.version,
      createdAt: value.createdAt,
    });
  }

  private async advance(workerId: string, run: ClaimedRun): Promise<void> {
    if (run.status === 'starting') {
      const receipt = await this.gateway.start(binding(run));
      await this.updateClaim(workerId, run, {
        status: 'in_progress',
        gatewaySessionRef: receipt.gatewaySessionRef,
        questionSetDigest: receipt.questionSetDigest,
        startedAt: new Date(receipt.startedAt),
        deadlineAt: new Date(receipt.deadlineAt),
        nextActionAt: new Date(receipt.deadlineAt),
      }, 'knowledge.exam.run.started');
      this.metrics.recordKnowledgeExamRun('start', 'success');
      return;
    }
    const gatewaySessionRef = required(run.gatewaySessionRef, 'KNOWLEDGE_EXAM_SESSION_MISSING');
    const questionSetDigest = required(run.questionSetDigest, 'KNOWLEDGE_EXAM_DIGEST_MISSING');
    if (run.status === 'in_progress') {
      const deadlineAt = requiredDate(run.deadlineAt, 'KNOWLEDGE_EXAM_DEADLINE_MISSING');
      const receipt = await this.gateway.timeout({
        ...binding(run),
        gatewaySessionRef,
        questionSetDigest,
        deadlineAt: deadlineAt.toISOString(),
      });
      await this.updateClaim(workerId, run, {
        status: 'submitted',
        submissionRef: receipt.submissionRef,
        submittedAt: new Date(receipt.submittedAt),
        submissionReason: 'timeout',
        timedOut: true,
        nextActionAt: new Date(),
      }, 'knowledge.exam.run.timed_out');
      this.metrics.recordKnowledgeExamRun('timeout', 'success');
      return;
    }
    const submissionRef = required(run.submissionRef, 'KNOWLEDGE_EXAM_SUBMISSION_MISSING');
    const submittedAt = requiredDate(
      run.submittedAt,
      'KNOWLEDGE_EXAM_SUBMITTED_AT_MISSING',
    ).toISOString();
    const result = run.status === 'pending_review'
      ? await this.gateway.status({
          ...binding(run),
          gatewaySessionRef,
          questionSetDigest,
          submissionRef,
          reviewEvidenceId: required(
            run.reviewEvidenceId,
            'KNOWLEDGE_EXAM_REVIEW_EVIDENCE_MISSING',
          ),
          timedOut: run.timedOut,
          submittedAt,
        })
      : await this.gateway.finalize({
          ...binding(run),
          gatewaySessionRef,
          questionSetDigest,
          submissionRef,
          timedOut: run.timedOut,
          submittedAt,
        });
    if (result.status === 'pending_review') {
      await this.updateClaim(workerId, run, {
        status: 'pending_review',
        submissionRef,
        reviewEvidenceId: result.reviewEvidenceId,
        submittedAt: new Date(submittedAt),
        submissionReason: run.submissionReason,
        timedOut: run.timedOut,
        reviewPolls: run.reviewPolls + 1,
        nextActionAt: new Date(Date.now() + reviewPollInterval(run)),
      }, run.status === 'pending_review'
        ? undefined
        : 'knowledge.exam.run.review_pending');
      this.metrics.recordKnowledgeExamRun('review', 'pending');
      return;
    }
    if (run.manualReviewRequired && run.reviewEvidenceId === null) {
      throw new Error('KNOWLEDGE_EXAM_MANUAL_REVIEW_EVIDENCE_MISSING');
    }
    await this.completeGrading(workerId, run, {
      submissionRef,
      questionSetDigest,
      submittedAt,
      timedOut: run.timedOut,
      scoreBps: result.scoreBps,
      passed: result.passed,
      gradingEvidenceId: result.gradingEvidenceId,
      gradedAt: result.gradedAt,
    });
    this.metrics.observeKnowledgeExamGrading(
      run.reviewEvidenceId === null ? 'automatic' : 'manual',
      (Date.parse(result.gradedAt) - Date.parse(submittedAt)) / 1_000,
    );
    this.metrics.recordKnowledgeExamRun('grade', 'success');
  }

  private async completeGrading(
    workerId: string,
    run: ClaimedRun,
    result: {
      readonly submissionRef: string;
      readonly questionSetDigest: string;
      readonly submittedAt: string;
      readonly timedOut: boolean;
      readonly scoreBps: number;
      readonly passed: boolean;
      readonly gradingEvidenceId: string;
      readonly gradedAt: string;
    },
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await this.context.run(workerContext(run), () => session.withTransaction(async () => {
        const gradedAt = new Date(result.gradedAt);
        const attempt = createExamAttempt({
          id: createEventId(gradedAt),
          tenantId: run.tenantId,
          assignmentId: run.assignmentId,
          attemptNumber: run.attemptNumber,
          submissionRef: result.submissionRef,
          questionSetDigest: result.questionSetDigest,
          gradingEvidenceId: result.gradingEvidenceId,
          questionMode: run.questionMode,
          gradingPolicyVersion: run.gradingPolicyVersion,
          passingRule: run.passingRule,
          ...(run.reviewEvidenceId === null
            ? {}
            : { manualReviewEvidenceId: run.reviewEvidenceId }),
          submissionReason: result.timedOut ? 'timeout' : 'learner',
          scoreBps: result.scoreBps,
          passingScoreBps: run.passingScoreBps,
          passedOverride: result.passed,
          serverGradingVerified: true,
        }, gradedAt);
        await this.attempts.create([{
          ...attempt,
          gradedAt: new Date(attempt.gradedAt),
        }], { session });
        const now = new Date();
        const updated = await this.runs.updateOne(
          {
            tenantId: run.tenantId,
            id: run.runId,
            version: run.version,
            lockedBy: workerId,
          },
          {
            $set: {
              status: 'graded',
              submissionRef: result.submissionRef,
              questionSetDigest: result.questionSetDigest,
              submittedAt: new Date(result.submittedAt),
              submissionReason: result.timedOut ? 'timeout' : 'learner',
              finalAttemptId: attempt.id,
              timedOut: result.timedOut,
              attempts: 0,
              nextActionAt: now,
              lastErrorCode: null,
              lockedAt: null,
              lockedBy: null,
              updatedAt: now,
            },
            $inc: { version: 1 },
          },
          { session, timestamps: false, runValidators: true },
        );
        if (updated.matchedCount !== 1) throw new Error('KNOWLEDGE_EXAM_RUN_CLAIM_LOST');
        await this.outbox.append(examGradedEvent(attempt), session);
      }));
    } finally {
      await session.endSession();
    }
    await this.auditAfterCommit(run, 'knowledge.exam.run.graded', {
      status: 'graded',
      attemptNumber: run.attemptNumber,
      passed: result.passed,
      timedOut: result.timedOut,
    });
  }

  private async updateClaim(
    workerId: string,
    run: ClaimedRun,
    fields: Readonly<Record<string, unknown>>,
    eventType?:
      | 'knowledge.exam.run.started'
      | 'knowledge.exam.run.timed_out'
      | 'knowledge.exam.run.review_pending',
  ): Promise<void> {
    const session = await this.connection.startSession();
    let status: string = run.status;
    try {
      await this.context.run(workerContext(run), () => session.withTransaction(async () => {
        const now = new Date();
        const updated = await this.runs.findOneAndUpdate(
          {
            tenantId: run.tenantId,
            id: run.runId,
            version: run.version,
            lockedBy: workerId,
          },
          {
            $set: {
              ...fields,
              attempts: 0,
              lastErrorCode: null,
              lockedAt: null,
              lockedBy: null,
              updatedAt: now,
            },
            $inc: { version: 1 },
          },
          {
            session,
            returnDocument: 'after',
            timestamps: false,
            runValidators: true,
          },
        ).lean().exec();
        if (updated === null) throw new Error('KNOWLEDGE_EXAM_RUN_CLAIM_LOST');
        status = updated.status;
        if (eventType !== undefined) {
          await this.outbox.append(
            runTransitionEvent(updated, eventType),
            session,
          );
        }
      }));
    } finally {
      await session.endSession();
    }
    await this.auditAfterCommit(run, `knowledge.exam.run.${status}`, {
      status,
      attemptNumber: run.attemptNumber,
    });
  }

  private async auditAfterCommit(
    run: ClaimedRun,
    action: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(run.tenantId, {
        traceId: `knowledge-exam:${run.runId}:${run.version}`,
        action,
        resourceType: 'knowledge_exam_run',
        resourceId: run.runId,
        riskLevel: 'R2',
        outcome: 'success',
        metadata,
      });
    } catch {
      this.logger.error({
        code: 'KNOWLEDGE_EXAM_AUDIT_AFTER_COMMIT_FAILED',
        runId: run.runId,
        action,
      });
    }
  }

  private async release(workerId: string, run: ClaimedRun, errorCode: string): Promise<void> {
    const attempts = run.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const session = await this.connection.startSession();
    try {
      await this.context.run(workerContext(run), () => session.withTransaction(async () => {
        const now = new Date();
        const update = {
          $set: {
            status: dead ? 'dead' : run.status,
            attempts,
            nextActionAt: dead
              ? now
              : new Date(now.getTime() + Math.min(15 * 60_000, 1_000 * (2 ** attempts))),
            lastErrorCode: errorCode,
            lockedAt: null,
            lockedBy: null,
            updatedAt: now,
          },
          ...(dead ? { $inc: { version: 1 } } : {}),
        };
        const updated = await this.runs.findOneAndUpdate(
          {
            tenantId: run.tenantId,
            id: run.runId,
            version: run.version,
            lockedBy: workerId,
          },
          update,
          {
            session,
            returnDocument: 'after',
            timestamps: false,
            runValidators: true,
          },
        ).lean().exec();
        if (updated === null) throw new Error('KNOWLEDGE_EXAM_RUN_CLAIM_LOST');
        if (dead) {
          await this.outbox.append(Object.freeze({
            type: 'knowledge.exam.run.dead',
            tenantId: updated.tenantId,
            aggregateId: updated.id,
            version: updated.version,
            occurredAt: updated.updatedAt.toISOString(),
            payload: Object.freeze({
              assignmentId: updated.assignmentId,
              courseVersionId: updated.courseVersionId,
              attemptNumber: updated.attemptNumber,
              questionMode: updated.questionMode,
              status: updated.status,
              timedOut: updated.timedOut,
              failureCode: errorCode,
            }),
          }), session);
        }
      }));
    } finally {
      await session.endSession();
    }
    this.metrics.recordKnowledgeExamRun('gateway', dead ? 'dead' : 'retry');
    if (dead) this.logger.error({
      code: 'KNOWLEDGE_EXAM_RUN_DEAD_LETTERED',
      runId: run.runId,
      status: run.status,
      attempts,
      failureCode: errorCode,
    });
    if (dead) await this.auditAfterCommit(run, 'knowledge.exam.run.dead', {
      status: 'dead',
      attemptNumber: run.attemptNumber,
      failureCode: errorCode,
    });
  }

  private async deferCircuitOpen(workerId: string, run: ClaimedRun): Promise<void> {
    const updated = await this.runs.updateOne(
      {
        tenantId: run.tenantId,
        id: run.runId,
        version: run.version,
        lockedBy: workerId,
      },
      {
        $set: {
          nextActionAt: new Date(Date.now() + 30_000),
          lockedAt: null,
          lockedBy: null,
          updatedAt: new Date(),
        },
      },
      { timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new Error('KNOWLEDGE_EXAM_RUN_CLAIM_LOST');
    this.metrics.recordKnowledgeExamRun('gateway', 'deferred');
  }

  private async refreshMetrics(): Promise<void> {
    const now = new Date();
    const rows = await this.runs.aggregate<{
      readonly _id: 'starting' | 'in_progress' | 'submitted' | 'pending_review' | 'dead';
      readonly count: number;
      readonly oldestCreatedAt: Date;
    }>([
      {
        $match: {
          status: {
            $in: ['starting', 'in_progress', 'submitted', 'pending_review', 'dead'],
          },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          oldestCreatedAt: { $min: '$createdAt' },
        },
      },
    ]).exec();
    const byStatus = new Map(rows.map((row) => [row._id, row]));
    for (const status of [
      'starting',
      'in_progress',
      'submitted',
      'pending_review',
      'dead',
    ] as const) {
      const row = byStatus.get(status);
      this.metrics.setKnowledgeExamRunBacklog(
        status,
        row?.count ?? 0,
        row === undefined
          ? 0
          : (now.getTime() - new Date(row.oldestCreatedAt).getTime()) / 1_000,
      );
    }
  }
}

export class GradingCircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;

  beforeRequest(now = Date.now()): void {
    if (this.openUntil > now) throw new Error('KNOWLEDGE_GRADING_CIRCUIT_OPEN');
    if (this.openUntil !== 0) {
      if (this.halfOpenProbe) throw new Error('KNOWLEDGE_GRADING_CIRCUIT_OPEN');
      this.halfOpenProbe = true;
    }
  }

  onSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  onFailure(now = Date.now()): void {
    this.halfOpenProbe = false;
    this.failures += 1;
    if (this.failures >= 5) this.openUntil = now + 30_000;
  }
}

function binding(run: ClaimedRun): KnowledgeExamOrchestrationInput {
  return Object.freeze({
    runId: run.runId,
    tenantId: run.tenantId,
    assignmentId: run.assignmentId,
    courseVersionId: run.courseVersionId,
    attemptNumber: run.attemptNumber,
    questionBankRef: run.questionBankRef,
    questionBankDigest: run.questionBankDigest,
    questionMode: run.questionMode,
    gradingPolicyVersion: run.gradingPolicyVersion,
    passingRule: run.passingRule,
    passingScoreBps: run.passingScoreBps,
    timeLimitMinutes: run.timeLimitMinutes,
    manualReviewRequired: run.manualReviewRequired,
    gradingSlaMinutes: run.gradingSlaMinutes,
    manualReviewSlaMinutes: run.manualReviewSlaMinutes,
  });
}

function workerContext(run: ClaimedRun) {
  return Object.freeze({
    tenant: {
      tenantId: run.tenantId,
      source: 'service_identity' as const,
    },
    actor: {
      actorType: 'system_job' as const,
      actorId: 'system:knowledge-exam',
      tenantId: run.tenantId,
      roleCodes: Object.freeze(['KNOWLEDGE_EXAM_WORKER']),
      scopes: Object.freeze(['erp:knowledge:exam:orchestrate']),
      departmentIds: Object.freeze([]),
      traceId: `knowledge-exam:${run.runId}:${run.version}`,
    },
  });
}

function runTransitionEvent(
  run: {
    readonly id: string;
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly courseVersionId: string;
    readonly attemptNumber: number;
    readonly questionMode: 'objective' | 'subjective' | 'mixed';
    readonly status: string;
    readonly timedOut: boolean;
    readonly version: number;
    readonly updatedAt: Date;
  },
  type:
    | 'knowledge.exam.run.started'
    | 'knowledge.exam.run.timed_out'
    | 'knowledge.exam.run.review_pending',
): KnowledgeDomainEvent {
  return Object.freeze({
    type,
    tenantId: run.tenantId,
    aggregateId: run.id,
    version: run.version,
    occurredAt: run.updatedAt.toISOString(),
    payload: Object.freeze({
      assignmentId: run.assignmentId,
      courseVersionId: run.courseVersionId,
      attemptNumber: run.attemptNumber,
      questionMode: run.questionMode,
      status: run.status,
      timedOut: run.timedOut,
    }),
  });
}

function required(value: string | null, code: string): string {
  if (value === null) throw new Error(code);
  return value;
}

function requiredDate(value: Date | null, code: string): Date {
  if (value === null) throw new Error(code);
  return value;
}

function reviewPollInterval(run: ClaimedRun): number {
  return Math.max(
    60_000,
    Math.min(5 * 60_000, Math.floor(run.manualReviewSlaMinutes * 60_000 / 12)),
  );
}

function assertWorker(workerId: string, limit: number): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new Error('KNOWLEDGE_EXAM_RUN_WORKER_INVALID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('KNOWLEDGE_EXAM_RUN_LIMIT_INVALID');
  }
}

function failureCode(caught: unknown): string {
  return caught instanceof Error && /^[A-Z0-9_]{3,128}$/u.test(caught.message)
    ? caught.message
    : 'KNOWLEDGE_EXAM_RUN_FAILED';
}
