import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { KnowledgeExamRun } from '../domain/index.js';
import {
  KnowledgeExamRunRecord,
  type KnowledgeExamRunDocument,
} from './knowledge-exam-run.schemas.js';

@Injectable()
export class KnowledgeExamRunRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(KnowledgeExamRunRecord.name)
    private readonly records: Model<KnowledgeExamRunDocument>,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<KnowledgeExamRun | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : toDomain(value);
  }

  async findActiveByAssignment(
    assignmentId: string,
    session?: ClientSession,
  ): Promise<KnowledgeExamRun | null> {
    const query = this.records.findOne({
      tenantId: this.tenantId(),
      assignmentId,
      status: { $in: ['starting', 'in_progress', 'submitted', 'pending_review'] },
    });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : toDomain(value);
  }

  async nextAttemptNumber(assignmentId: string, session: ClientSession): Promise<number> {
    const value = await this.records.findOne({ tenantId: this.tenantId(), assignmentId })
      .sort({ attemptNumber: -1 }).session(session).lean().exec();
    return (value?.attemptNumber ?? 0) + 1;
  }

  async insert(run: KnowledgeExamRun, session: ClientSession): Promise<void> {
    if (run.tenantId !== this.tenantId()) throw new Error('Knowledge 考试运行拒绝跨租户写入');
    await this.records.create([{
      ...run,
      startedAt: toDate(run.startedAt),
      deadlineAt: toDate(run.deadlineAt),
      submittedAt: toDate(run.submittedAt),
      nextActionAt: new Date(run.nextActionAt),
      createdAt: new Date(run.createdAt),
      updatedAt: new Date(run.updatedAt),
      lockedAt: null,
      lockedBy: null,
    }], { session });
  }

  async submit(
    id: string,
    expectedVersion: number,
    submissionRef: string,
    now: Date,
    session: ClientSession,
  ): Promise<KnowledgeExamRun | null> {
    const value = await this.records.findOneAndUpdate(
      {
        tenantId: this.tenantId(),
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
    ).lean().exec();
    return value === null ? null : toDomain(value);
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }
}

function toDomain(value: KnowledgeExamRunRecord): KnowledgeExamRun {
  return Object.freeze({
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
