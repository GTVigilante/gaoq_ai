import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type { OnboardingStatus, OnboardingTaskCode } from '../domain/index.js';

const MAX_ID_LENGTH = 128;
const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value >= 1;

@Schema({ collection: 'onboarding_instances', timestamps: true, versionKey: false, id: false })
export class OnboardingInstanceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) offerId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) applicationId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) candidateId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  acceptanceEvidenceId!: string;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) signedEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) identityEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) materialsEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  orgAssignmentEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) trainingEvidenceId!: string | null;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) departmentId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) jobLevelId!: string;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) orgPositionId!: string | null;
  @Prop({ type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  proposedStartDate!: string;
  @Prop({
    type: String,
    enum: ['in_progress', 'ready', 'provisioning', 'completed', 'cancelled'],
    required: true,
  })
  status!: OnboardingStatus;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  completionEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH }) employmentId!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: isPositiveInteger } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type OnboardingInstanceDocument = HydratedDocument<OnboardingInstanceRecord>;
export const OnboardingInstanceRecordSchema = SchemaFactory.createForClass(OnboardingInstanceRecord);
OnboardingInstanceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OnboardingInstanceRecordSchema.index({ tenantId: 1, offerId: 1 }, { unique: true });
OnboardingInstanceRecordSchema.index({ tenantId: 1, applicationId: 1 }, { unique: true });
OnboardingInstanceRecordSchema.index({ tenantId: 1, status: 1, updatedAt: 1 });

@Schema({ collection: 'onboarding_task_evidence', timestamps: true, versionKey: false, id: false })
export class OnboardingTaskEvidenceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  onboardingInstanceId!: string;
  @Prop({
    type: String,
    enum: [
      'contract_archived', 'identity_verified', 'materials_verified',
      'org_assignment_verified', 'mandatory_training_completed',
    ],
    required: true,
    immutable: true,
  })
  taskCode!: OnboardingTaskCode;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) evidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH }) actorId!: string;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}

export type OnboardingTaskEvidenceDocument = HydratedDocument<OnboardingTaskEvidenceRecord>;
export const OnboardingTaskEvidenceRecordSchema = SchemaFactory.createForClass(
  OnboardingTaskEvidenceRecord,
);
OnboardingTaskEvidenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
OnboardingTaskEvidenceRecordSchema.index(
  { tenantId: 1, onboardingInstanceId: 1, taskCode: 1 },
  { unique: true },
);
OnboardingTaskEvidenceRecordSchema.index({ tenantId: 1, evidenceId: 1 });
