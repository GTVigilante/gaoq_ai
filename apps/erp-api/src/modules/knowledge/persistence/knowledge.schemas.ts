import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const MAX_ID = 128;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;
const bps = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 10_000;

@Schema({ collection: 'knowledge_course_versions', timestamps: true, versionKey: false, id: false })
export class KnowledgeCourseVersionRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) courseCode!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } }) revision!: number;
  @Prop({ type: String, required: true, maxlength: MAX_ID }) title!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) contentRef!: string;
  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID }) questionBankRef!: string | null;
  @Prop({ type: String, default: null, immutable: true, minlength: 43, maxlength: 43 })
  questionBankDigest!: string | null;
  @Prop({ type: Number, default: null, immutable: true, validate: { validator: bps } })
  passingScoreBps!: number | null;
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

@Schema({ collection: 'knowledge_exam_attempts', timestamps: true, versionKey: false, id: false })
export class KnowledgeExamAttemptRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) assignmentId!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } })
  attemptNumber!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) submissionRef!: string;
  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43 })
  questionSetDigest!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID }) gradingEvidenceId!: string;
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
