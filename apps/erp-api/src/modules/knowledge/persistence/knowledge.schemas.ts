import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const MAX_ID = 128;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
const bps = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
const nullableBps = (value: number | null): boolean => value === null || bps(value);

@Schema({ collection: 'knowledge_course_versions', timestamps: true, versionKey: false, id: false })
export class KnowledgeCourseVersionRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) courseCode!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } }) revision!: number;
  @Prop({ type: String, required: true, maxlength: MAX_ID }) title!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) contentRef!: string;
  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID }) questionBankRef!: string | null;
  @Prop({
    type: String,
    default: null,
    immutable: true,
    match: /^[A-Za-z0-9_-]{43}$/u,
  })
  questionBankDigest!: string | null;
  @Prop({ type: Number, default: null, immutable: true, validate: { validator: nullableBps } })
  passingScoreBps!: number | null;
  @Prop({
    type: String,
    enum: ['objective', 'subjective', 'mixed'],
    default: null,
    immutable: true,
  })
  questionMode!: 'objective' | 'subjective' | 'mixed' | null;
  @Prop({ type: Number, default: null, immutable: true, min: 5, max: 240 })
  timeLimitMinutes!: number | null;
  @Prop({ type: Number, default: null, immutable: true, min: 1, max: 10 })
  maxAttempts!: number | null;
  @Prop({
    type: String,
    default: null,
    immutable: true,
    match: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u,
  })
  gradingPolicyVersion!: string | null;
  @Prop({
    type: String,
    enum: ['score_threshold', 'all_required_sections'],
    default: null,
    immutable: true,
  })
  passingRule!: 'score_threshold' | 'all_required_sections' | null;
  @Prop({ type: Number, default: null, immutable: true, min: 1, max: 60 })
  gradingSlaMinutes!: number | null;
  @Prop({ type: Number, default: null, immutable: true, min: 30, max: 10_080 })
  manualReviewSlaMinutes!: number | null;
  @Prop({ type: Boolean, required: true, immutable: true, default: false })
  manualReviewRequired!: boolean;
  @Prop({
    type: String,
    enum: ['assigned_only', 'employment_scope'],
    required: true,
    immutable: true,
    default: 'assigned_only',
  })
  audienceMode!: 'assigned_only' | 'employment_scope';
  @Prop({
    type: [String],
    required: true,
    immutable: true,
    default: [],
    validate: {
      validator: (values: unknown): boolean => validAudienceIds(values),
      message: 'audienceDepartmentIds 必须为不超过 200 个的不重复标识',
    },
  })
  audienceDepartmentIds!: string[];
  @Prop({
    type: [String],
    required: true,
    immutable: true,
    default: [],
    validate: {
      validator: (values: unknown): boolean => validAudienceIds(values),
      message: 'audiencePositionIds 必须为不超过 200 个的不重复标识',
    },
  })
  audiencePositionIds!: string[];
  @Prop({ type: String, enum: ['draft', 'published', 'retired'], required: true })
  status!: 'draft' | 'published' | 'retired';
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type KnowledgeCourseVersionDocument = HydratedDocument<KnowledgeCourseVersionRecord>;
export const KnowledgeCourseVersionRecordSchema = SchemaFactory.createForClass(KnowledgeCourseVersionRecord);
KnowledgeCourseVersionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeCourseVersionRecordSchema.index({ tenantId: 1, courseCode: 1, revision: 1 }, { unique: true });
KnowledgeCourseVersionRecordSchema.index({ tenantId: 1, status: 1, courseCode: 1 });
KnowledgeCourseVersionRecordSchema.index({ tenantId: 1, status: 1, audienceDepartmentIds: 1 });
KnowledgeCourseVersionRecordSchema.index({ tenantId: 1, status: 1, audiencePositionIds: 1 });
KnowledgeCourseVersionRecordSchema.pre('validate', function validateAudience() {
  const departmentIds = Array.isArray(this.audienceDepartmentIds)
    ? this.audienceDepartmentIds
    : [];
  const positionIds = Array.isArray(this.audiencePositionIds)
    ? this.audiencePositionIds
    : [];
  if (
    (this.audienceMode === 'assigned_only' &&
      (departmentIds.length > 0 || positionIds.length > 0)) ||
    (this.audienceMode === 'employment_scope' &&
      departmentIds.length === 0 && positionIds.length === 0)
  ) throw new Error('知识课程授权范围组合非法');
  const examBase = [
    this.questionBankRef,
    this.questionBankDigest,
    this.passingScoreBps,
  ];
  if (
    examBase.some((value) => value === null) &&
    examBase.some((value) => value !== null)
  ) throw new Error('知识课程考试基础配置组合非法');
  const configured = examBase.every((value) => value !== null);
  const policy = [
    this.questionMode,
    this.timeLimitMinutes,
    this.maxAttempts,
    this.gradingPolicyVersion,
    this.passingRule,
    this.gradingSlaMinutes,
    this.manualReviewSlaMinutes,
  ];
  if (
    configured
      ? policy.some((value) => value === null) ||
        this.manualReviewRequired !==
          (this.questionMode === 'subjective' || this.questionMode === 'mixed')
      : policy.some((value) => value !== null) || this.manualReviewRequired
  ) throw new Error('知识课程考试策略组合非法');
});

@Schema({ collection: 'knowledge_training_assignments', timestamps: true, versionKey: false, id: false })
export class KnowledgeTrainingAssignmentRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) onboardingInstanceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) courseVersionId!: string;
  @Prop({ type: Boolean, required: true, immutable: true }) mandatory!: boolean;
  @Prop({ type: Boolean, required: true, immutable: true }) examRequired!: boolean;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ }) dueDate!: string;
  @Prop({ type: String, enum: ['assigned', 'in_progress', 'completed', 'expired'], required: true })
  status!: 'assigned' | 'in_progress' | 'completed' | 'expired';
  @Prop({ type: Number, required: true, validate: { validator: bps } }) progressBps!: number;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) passedExamAttemptId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID }) completionEvidenceId!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type KnowledgeTrainingAssignmentDocument = HydratedDocument<KnowledgeTrainingAssignmentRecord>;
export const KnowledgeTrainingAssignmentRecordSchema = SchemaFactory.createForClass(
  KnowledgeTrainingAssignmentRecord,
);
KnowledgeTrainingAssignmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeTrainingAssignmentRecordSchema.index(
  { tenantId: 1, onboardingInstanceId: 1, courseVersionId: 1 },
  { unique: true },
);
KnowledgeTrainingAssignmentRecordSchema.index({ tenantId: 1, onboardingInstanceId: 1, mandatory: 1, status: 1 });
KnowledgeTrainingAssignmentRecordSchema.index({ tenantId: 1, mandatory: 1, status: 1 });
KnowledgeTrainingAssignmentRecordSchema.pre('validate', function validateTrainingAssignment() {
  const hasPassedExam = this.passedExamAttemptId !== null;
  const hasCompletionEvidence = this.completionEvidenceId !== null;
  if (
    (this.status === 'assigned' &&
      (this.progressBps !== 0 || hasPassedExam || hasCompletionEvidence)) ||
    (this.status === 'in_progress' &&
      (this.progressBps === 0 || hasPassedExam || hasCompletionEvidence)) ||
    (this.status === 'completed' &&
      (
        this.progressBps !== 10_000 ||
        !hasCompletionEvidence ||
        this.examRequired !== hasPassedExam
      )) ||
    (this.status === 'expired' && (hasPassedExam || hasCompletionEvidence))
  ) throw new Error('Knowledge 培训任务状态与证据组合非法');
});

@Schema({ collection: 'knowledge_exam_attempts', timestamps: true, versionKey: false, id: false })
export class KnowledgeExamAttemptRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) assignmentId!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } })
  attemptNumber!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) submissionRef!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[A-Za-z0-9_-]{43}$/u,
  })
  questionSetDigest!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) gradingEvidenceId!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['objective', 'subjective', 'mixed'],
    default: 'objective',
  })
  questionMode!: 'objective' | 'subjective' | 'mixed';
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u,
    default: 'objective-auto-v1',
  })
  gradingPolicyVersion!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['score_threshold', 'all_required_sections'],
    default: 'score_threshold',
  })
  passingRule!: 'score_threshold' | 'all_required_sections';
  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID })
  manualReviewEvidenceId!: string | null;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['learner', 'timeout'],
    default: 'learner',
  })
  submissionReason!: 'learner' | 'timeout';
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: bps } }) scoreBps!: number;
  @Prop({ type: Boolean, required: true, immutable: true }) passed!: boolean;
  @Prop({ type: Date, required: true, immutable: true }) gradedAt!: Date;
}
export type KnowledgeExamAttemptDocument = HydratedDocument<KnowledgeExamAttemptRecord>;
export const KnowledgeExamAttemptRecordSchema = SchemaFactory.createForClass(KnowledgeExamAttemptRecord);
KnowledgeExamAttemptRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeExamAttemptRecordSchema.index({ tenantId: 1, assignmentId: 1, attemptNumber: 1 }, { unique: true });
KnowledgeExamAttemptRecordSchema.index({ tenantId: 1, submissionRef: 1 }, { unique: true });
KnowledgeExamAttemptRecordSchema.index({ tenantId: 1, gradingEvidenceId: 1 }, { unique: true });
KnowledgeExamAttemptRecordSchema.index(
  { tenantId: 1, manualReviewEvidenceId: 1 },
  {
    unique: true,
    partialFilterExpression: { manualReviewEvidenceId: { $type: 'string' } },
  },
);
KnowledgeExamAttemptRecordSchema.pre('validate', function validateExamAttempt() {
  if (
    (this.questionMode === 'subjective' || this.questionMode === 'mixed') &&
    this.manualReviewEvidenceId === null
  ) throw new Error('Knowledge 主观或混合题缺少人工复核证据');
});

@Schema({ collection: 'knowledge_progress_events', timestamps: true, versionKey: false, id: false })
export class KnowledgeProgressEventRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) assignmentId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) source!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) sourceEventId!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: bps } }) progressBps!: number;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type KnowledgeProgressEventDocument = HydratedDocument<KnowledgeProgressEventRecord>;
export const KnowledgeProgressEventRecordSchema = SchemaFactory.createForClass(KnowledgeProgressEventRecord);
KnowledgeProgressEventRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeProgressEventRecordSchema.index({ tenantId: 1, source: 1, sourceEventId: 1 }, { unique: true });

@Schema({ collection: 'knowledge_onboarding_attestations', timestamps: true, versionKey: false, id: false })
export class KnowledgeOnboardingAttestationRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) onboardingInstanceId!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43 }) digest!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } }) assignmentCount!: number;
  @Prop({ type: Date, required: true, immutable: true }) attestedAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type KnowledgeOnboardingAttestationDocument = HydratedDocument<KnowledgeOnboardingAttestationRecord>;
export const KnowledgeOnboardingAttestationRecordSchema = SchemaFactory.createForClass(
  KnowledgeOnboardingAttestationRecord,
);
KnowledgeOnboardingAttestationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
KnowledgeOnboardingAttestationRecordSchema.index({ tenantId: 1, onboardingInstanceId: 1 }, { unique: true });

function validAudienceIds(values: unknown): boolean {
  return Array.isArray(values) &&
    values.length <= 200 &&
    new Set(values).size === values.length &&
    values.every((value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID);
}
