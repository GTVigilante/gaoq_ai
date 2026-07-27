import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { KnowledgeExamRunStatus } from '../domain/index.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
const bps = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= 10_000;

@Schema({ collection: 'knowledge_exam_runs', timestamps: true, versionKey: false, id: false })
export class KnowledgeExamRunRecord {
  @Prop({ type: String, required: true, immutable: true, match: SAFE_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: SAFE_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: SAFE_ID }) assignmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: SAFE_ID })
  courseVersionId!: string;
  @Prop({ type: String, required: true, immutable: true, match: SAFE_ID })
  questionBankRef!: string;
  @Prop({ type: String, required: true, immutable: true, match: DIGEST })
  questionBankDigest!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } })
  attemptNumber!: number;
  @Prop({ type: String, required: true, immutable: true, enum: ['objective', 'subjective', 'mixed'] })
  questionMode!: 'objective' | 'subjective' | 'mixed';
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u,
  })
  gradingPolicyVersion!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['score_threshold', 'all_required_sections'],
  })
  passingRule!: 'score_threshold' | 'all_required_sections';
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: bps } })
  passingScoreBps!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 10 })
  maxAttempts!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 5, max: 240 })
  timeLimitMinutes!: number;
  @Prop({ type: Boolean, required: true, immutable: true }) manualReviewRequired!: boolean;
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 60 })
  gradingSlaMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 30, max: 10_080 })
  manualReviewSlaMinutes!: number;
  @Prop({
    type: String,
    required: true,
    enum: ['starting', 'in_progress', 'submitted', 'pending_review', 'graded', 'dead'],
  })
  status!: KnowledgeExamRunStatus;
  @Prop({ type: String, default: null, match: SAFE_ID }) gatewaySessionRef!: string | null;
  @Prop({ type: String, default: null, match: SAFE_ID }) submissionRef!: string | null;
  @Prop({ type: String, default: null, match: DIGEST })
  questionSetDigest!: string | null;
  @Prop({ type: String, default: null, match: SAFE_ID }) reviewEvidenceId!: string | null;
  @Prop({ type: String, default: null, match: SAFE_ID }) finalAttemptId!: string | null;
  @Prop({ type: Date, default: null }) startedAt!: Date | null;
  @Prop({ type: Date, default: null }) deadlineAt!: Date | null;
  @Prop({ type: Date, default: null }) submittedAt!: Date | null;
  @Prop({ type: String, enum: ['learner', 'timeout'], default: null })
  submissionReason!: 'learner' | 'timeout' | null;
  @Prop({ type: Boolean, required: true, default: false }) timedOut!: boolean;
  @Prop({ type: Number, required: true, min: 0, max: 8 }) attempts!: number;
  @Prop({ type: Number, required: true, min: 0, max: 100_000, default: 0 })
  reviewPolls!: number;
  @Prop({ type: Date, required: true }) nextActionAt!: Date;
  @Prop({ type: String, default: null, match: /^[A-Z0-9_]{3,128}$/u })
  lastErrorCode!: string | null;
  @Prop({ type: Date, default: null }) lockedAt!: Date | null;
  @Prop({ type: String, default: null, match: SAFE_ID }) lockedBy!: string | null;
  @Prop({
    type: String,
    default: null,
    maxlength: 256,
    match: /^[\p{L}\p{N} ._:-]{8,256}$/u,
  })
  replayReason!: string | null;
  @Prop({ type: Date, default: null }) replayedAt!: Date | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type KnowledgeExamRunDocument = HydratedDocument<KnowledgeExamRunRecord>;
export const KnowledgeExamRunRecordSchema = SchemaFactory.createForClass(KnowledgeExamRunRecord);
KnowledgeExamRunRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeExamRunRecordSchema.index(
  { tenantId: 1, assignmentId: 1, attemptNumber: 1 },
  { unique: true },
);
KnowledgeExamRunRecordSchema.index(
  { tenantId: 1, submissionRef: 1 },
  {
    unique: true,
    partialFilterExpression: { submissionRef: { $type: 'string' } },
  },
);
KnowledgeExamRunRecordSchema.index(
  { tenantId: 1, assignmentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['starting', 'in_progress', 'submitted', 'pending_review'] },
    },
  },
);
KnowledgeExamRunRecordSchema.index({ status: 1, nextActionAt: 1, lockedAt: 1 });
KnowledgeExamRunRecordSchema.pre('validate', function validateExamRun() {
  if (
    this.attemptNumber > this.maxAttempts ||
    this.manualReviewRequired !==
      (this.questionMode === 'subjective' || this.questionMode === 'mixed')
  ) throw new Error('Knowledge 考试运行策略组合非法');
  if (
    this.status === 'starting' &&
    (
      this.gatewaySessionRef !== null ||
      this.questionSetDigest !== null ||
      this.startedAt !== null ||
      this.deadlineAt !== null ||
      this.submissionRef !== null ||
      this.submittedAt !== null ||
      this.submissionReason !== null ||
      this.reviewEvidenceId !== null ||
      this.finalAttemptId !== null ||
      this.timedOut
    )
  ) throw new Error('Knowledge 考试启动状态非法');
  if (
    ['in_progress', 'submitted', 'pending_review', 'graded'].includes(this.status) &&
    (this.gatewaySessionRef === null || this.questionSetDigest === null ||
      this.startedAt === null || this.deadlineAt === null)
  ) throw new Error('Knowledge 考试运行证据不完整');
  if (
    ['submitted', 'pending_review', 'graded'].includes(this.status) &&
    (
      this.submissionRef === null ||
      this.submittedAt === null ||
      this.submissionReason === null
    )
  ) throw new Error('Knowledge 考试提交证据不完整');
  if (
    this.timedOut !== (this.submissionReason === 'timeout') ||
    (this.status === 'in_progress' &&
      (
        this.submissionRef !== null ||
        this.submittedAt !== null ||
        this.submissionReason !== null ||
        this.reviewEvidenceId !== null ||
        this.finalAttemptId !== null ||
        this.timedOut
      ))
  ) throw new Error('Knowledge 考试超时证据组合非法');
  if (
    this.startedAt !== null &&
    this.deadlineAt !== null &&
    this.deadlineAt.getTime() <= this.startedAt.getTime()
  ) throw new Error('Knowledge 考试时限组合非法');
  if (
    this.timedOut &&
    this.submittedAt !== null &&
    this.deadlineAt !== null &&
    this.submittedAt.getTime() !== this.deadlineAt.getTime()
  ) throw new Error('Knowledge 考试超时提交时间非法');
  if (
    this.status === 'submitted' &&
    (this.reviewEvidenceId !== null || this.finalAttemptId !== null)
  ) throw new Error('Knowledge 考试已提交状态非法');
  if (
    this.status === 'pending_review' &&
    (this.reviewEvidenceId === null || this.finalAttemptId !== null)
  ) throw new Error('Knowledge 考试人工复核状态非法');
  if (
    this.status === 'graded' &&
    (
      this.finalAttemptId === null ||
      (this.manualReviewRequired && this.reviewEvidenceId === null)
    )
  ) {
    throw new Error('Knowledge 考试终态缺少最终尝试');
  }
  if (this.status !== 'graded' && this.finalAttemptId !== null) {
    throw new Error('Knowledge 考试非评分终态不能绑定最终尝试');
  }
  if (
    (this.lockedAt === null) !== (this.lockedBy === null)
  ) throw new Error('Knowledge 考试运行锁组合非法');
});
