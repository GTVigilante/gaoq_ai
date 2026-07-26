import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const RECRUITMENT_RESUME_ANALYSIS_STATUSES = [
  'queued', 'processing', 'review_required', 'approved', 'failed',
] as const;
export type RecruitmentResumeAnalysisStatus =
  typeof RECRUITMENT_RESUME_ANALYSIS_STATUSES[number];

export const RECRUITMENT_RESUME_TAG_CATEGORIES = [
  'role_family', 'skill', 'industry', 'seniority', 'language',
] as const;
export type RecruitmentResumeTagCategory =
  typeof RECRUITMENT_RESUME_TAG_CATEGORIES[number];

export const RECRUITMENT_RESUME_TAG_STATUSES = [
  'suggested', 'confirmed', 'rejected',
] as const;
export type RecruitmentResumeTagStatus =
  typeof RECRUITMENT_RESUME_TAG_STATUSES[number];

@Schema({ _id: false, id: false })
export class RecruitmentResumeProfileRecord {
  @Prop({ type: String, required: true, maxlength: 200 })
  headline!: string;

  @Prop({ type: String, required: true, maxlength: 800 })
  summary!: string;

  @Prop({ type: Number, required: true, min: 0, max: 80 })
  yearsExperience!: number;

  @Prop({
    type: String,
    enum: ['unknown', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'],
    required: true,
  })
  educationLevel!: 'unknown' | 'high_school' | 'associate' | 'bachelor' | 'master' | 'doctorate';

  @Prop({ type: [{ type: String, maxlength: 64 }], required: true, default: [] })
  skills!: string[];

  @Prop({ type: [{ type: String, maxlength: 96 }], required: true, default: [] })
  jobTitles!: string[];

  @Prop({ type: [{ type: String, maxlength: 64 }], required: true, default: [] })
  industries!: string[];

  @Prop({ type: [{ type: String, maxlength: 64 }], required: true, default: [] })
  languages!: string[];
}

const RecruitmentResumeProfileRecordSchema =
  SchemaFactory.createForClass(RecruitmentResumeProfileRecord);

@Schema({ _id: false, id: false })
export class RecruitmentResumeTagRecord {
  @Prop({ type: String, required: true, enum: RECRUITMENT_RESUME_TAG_CATEGORIES })
  category!: RecruitmentResumeTagCategory;

  @Prop({ type: String, required: true, maxlength: 64, match: CODE_PATTERN })
  code!: string;

  @Prop({ type: String, required: true, maxlength: 64 })
  label!: string;

  @Prop({ type: Number, required: true, min: 0, max: 1 })
  confidence!: number;

  @Prop({ type: String, required: true, maxlength: 160 })
  evidence!: string;

  @Prop({ type: String, required: true, enum: ['ai', 'manual'] })
  source!: 'ai' | 'manual';

  @Prop({ type: String, required: true, enum: RECRUITMENT_RESUME_TAG_STATUSES })
  status!: RecruitmentResumeTagStatus;
}

const RecruitmentResumeTagRecordSchema =
  SchemaFactory.createForClass(RecruitmentResumeTagRecord);

/**
 * 简历 AI 分析快照。
 *
 * 仅保存去标识化结构结果与标签决策；原文件、提取正文、姓名和联系方式不得进入集合。
 */
@Schema({
  collection: 'recruitment_resume_analyses',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class RecruitmentResumeAnalysisRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  candidateId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  resumeEvidenceId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: CODE_PATTERN })
  promptVersion!: string;

  @Prop({ type: String, required: true, enum: RECRUITMENT_RESUME_ANALYSIS_STATUSES })
  status!: RecruitmentResumeAnalysisStatus;

  @Prop({ type: RecruitmentResumeProfileRecordSchema, default: null })
  profile!: RecruitmentResumeProfileRecord | null;

  @Prop({ type: [RecruitmentResumeTagRecordSchema], required: true, default: [] })
  tags!: RecruitmentResumeTagRecord[];

  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  aiModel!: string | null;

  @Prop({ type: String, default: null, match: HASH_PATTERN })
  sourceChecksum!: string | null;

  @Prop({ type: String, default: null, maxlength: 128, match: /^[A-Z0-9_]{3,128}$/ })
  failureCode!: string | null;

  @Prop({ type: Date, default: null })
  processingStartedAt!: Date | null;

  @Prop({ type: Date, default: null })
  analyzedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  reviewedBy!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: Date, required: true })
  retentionExpiresAt!: Date;

  @Prop({ type: Number, required: true, min: 0, max: 10 })
  attempts!: number;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentResumeAnalysisDocument =
  HydratedDocument<RecruitmentResumeAnalysisRecord>;
export const RecruitmentResumeAnalysisRecordSchema =
  SchemaFactory.createForClass(RecruitmentResumeAnalysisRecord);

RecruitmentResumeAnalysisRecordSchema.pre('validate', function validateState() {
  const record = this as RecruitmentResumeAnalysisRecord;
  const hasResult = record.profile !== null && record.sourceChecksum !== null &&
    record.aiModel !== null && record.analyzedAt !== null && record.tags.length > 0;
  if (
    ['review_required', 'approved'].includes(record.status) !== hasResult
  ) this.invalidate('status', '简历分析终态必须包含完整结构化结果');
  if (record.status === 'processing' !== (record.processingStartedAt !== null)) {
    this.invalidate('processingStartedAt', '简历分析处理状态与租约时间不一致');
  }
  if (record.status === 'failed' !== (record.failureCode !== null)) {
    this.invalidate('failureCode', '简历分析失败状态与失败码不一致');
  }
  if (record.status === 'approved' !== (record.reviewedBy !== null && record.reviewedAt !== null)) {
    this.invalidate('reviewedAt', '简历分析确认状态必须记录复核人和时间');
  }
});

RecruitmentResumeAnalysisRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentResumeAnalysisRecordSchema.index(
  { tenantId: 1, candidateId: 1, resumeEvidenceId: 1, promptVersion: 1 },
  { unique: true },
);
RecruitmentResumeAnalysisRecordSchema.index({
  tenantId: 1, status: 1, updatedAt: -1, id: 1,
});
RecruitmentResumeAnalysisRecordSchema.index({
  tenantId: 1, 'tags.code': 1, 'tags.status': 1, updatedAt: -1,
});
RecruitmentResumeAnalysisRecordSchema.index({ retentionExpiresAt: 1 });
