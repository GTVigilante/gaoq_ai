import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type {
  CandidateApplicationStage,
  RecruitmentPositionStatus,
} from '../domain/index.js';
import { RECRUITMENT_CODE_PATTERN, RECRUITMENT_ID_PATTERN } from '../domain/index.js';

const BLIND_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const STRING_ID = { type: String, required: true, maxlength: 128, match: RECRUITMENT_ID_PATTERN } as const;
const TERMINAL_APPLICATION_STAGES: readonly CandidateApplicationStage[] = [
  'hired', 'rejected', 'withdrawn',
];
const APPLICATION_STAGES: readonly CandidateApplicationStage[] = [
  'applied', 'screening', 'interview', 'offer_approval', 'offer_sent',
  'offer_accepted', 'preboarding', 'hired', 'rejected', 'withdrawn',
];

@Schema({ _id: false, id: false })
class CandidateConsentRecord {
  @Prop({ type: String, required: true, maxlength: 64, match: RECRUITMENT_CODE_PATTERN })
  version!: string;

  @Prop({ type: String, required: true, minlength: 3, maxlength: 256 })
  purpose!: string;

  @Prop({ type: String, enum: ['portal', 'channel', 'manual_import'], required: true })
  source!: 'portal' | 'channel' | 'manual_import';

  @Prop({ type: Date, required: true, immutable: true })
  capturedAt!: Date;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  withdrawnAt!: Date | null;
}

const CandidateConsentRecordSchema = SchemaFactory.createForClass(CandidateConsentRecord);

/** 候选人主档；Mongo 只保存身份密文与盲索引，不保存姓名、手机或邮箱明文。 */
@Schema({ collection: 'recruitment_candidates', timestamps: true, versionKey: false, id: false })
export class RecruitmentCandidateRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ ...STRING_ID, immutable: true })
  tenantId!: string;

  @Prop({ type: String, enum: ['active', 'consent_withdrawn', 'anonymized'], required: true })
  status!: 'active' | 'consent_withdrawn' | 'anonymized';

  @Prop({ type: String, default: null, maxlength: 128, match: RECRUITMENT_ID_PATTERN })
  identityKeyId!: string | null;

  @Prop({ type: String, default: null, maxlength: 32, match: BASE64URL_PATTERN })
  identityIv!: string | null;

  @Prop({ type: String, default: null, maxlength: 131_072, match: BASE64URL_PATTERN })
  identityCiphertext!: string | null;

  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  identityAuthTag!: string | null;

  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true, default: [] })
  phoneBlindIndexes!: string[];

  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true, default: [] })
  emailBlindIndexes!: string[];

  @Prop({ type: CandidateConsentRecordSchema, required: true })
  consent!: CandidateConsentRecord;

  @Prop({ type: Date, required: true })
  retentionExpiresAt!: Date;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentCandidateDocument = HydratedDocument<RecruitmentCandidateRecord>;
export const RecruitmentCandidateRecordSchema = SchemaFactory.createForClass(RecruitmentCandidateRecord);

RecruitmentCandidateRecordSchema.pre('validate', function () {
  const record = this as RecruitmentCandidateRecord;
  const protectedFields = [
    record.identityKeyId, record.identityIv, record.identityCiphertext, record.identityAuthTag,
  ];
  if (record.status === 'anonymized') {
    if (protectedFields.some((value) => value !== null)) throw new Error('匿名候选人不能保留身份密文');
    if (record.phoneBlindIndexes.length > 0 || record.emailBlindIndexes.length > 0) {
      throw new Error('匿名候选人不能保留身份盲索引');
    }
  } else {
    if (protectedFields.some((value) => value === null)) throw new Error('候选人必须保存完整身份密文');
    if (record.phoneBlindIndexes.length + record.emailBlindIndexes.length === 0) {
      throw new Error('候选人必须保存至少一类联系盲索引');
    }
  }
  if (record.status === 'active' && record.consent.withdrawnAt !== null) {
    throw new Error('有效候选人不能存在授权撤回时间');
  }
  if (record.status === 'consent_withdrawn' && record.consent.withdrawnAt === null) {
    throw new Error('授权撤回候选人必须记录撤回时间');
  }
});

RecruitmentCandidateRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentCandidateRecordSchema.index(
  { tenantId: 1, phoneBlindIndexes: 1 },
  { unique: true, sparse: true },
);
RecruitmentCandidateRecordSchema.index(
  { tenantId: 1, emailBlindIndexes: 1 },
  { unique: true, sparse: true },
);
RecruitmentCandidateRecordSchema.index({ tenantId: 1, status: 1, retentionExpiresAt: 1 });

/** HC 招聘需求；审批实例只以引用关联，审批聚合仍由 Approval 权威管理。 */
@Schema({ collection: 'recruitment_requisitions', timestamps: true, versionKey: false, id: false })
export class RecruitmentRequisitionRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ ...STRING_ID, immutable: true })
  tenantId!: string;

  @Prop({ ...STRING_ID, immutable: true })
  departmentId!: string;

  @Prop({ type: String, required: true, minlength: 1, maxlength: 128 })
  positionTitle!: string;

  @Prop({ type: Number, required: true, min: 1, max: 10_000 })
  headcount!: number;

  @Prop({ type: String, required: true, minlength: 3, maxlength: 4_096 })
  justification!: string;

  @Prop({
    type: String,
    enum: ['draft', 'pending_approval', 'approved', 'rejected', 'closed'],
    required: true,
  })
  status!: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'closed';

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  approvalInstanceId!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  @Prop({ ...STRING_ID, immutable: true })
  createdBy!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentRequisitionDocument = HydratedDocument<RecruitmentRequisitionRecord>;
export const RecruitmentRequisitionRecordSchema = SchemaFactory.createForClass(RecruitmentRequisitionRecord);

RecruitmentRequisitionRecordSchema.pre('validate', function () {
  const record = this as RecruitmentRequisitionRecord;
  const approvalRequired = ['pending_approval', 'approved', 'rejected'].includes(record.status);
  if (approvalRequired !== (record.approvalInstanceId !== null)) {
    throw new Error('HC 审批状态与审批实例引用不一致');
  }
});

RecruitmentRequisitionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentRequisitionRecordSchema.index({ tenantId: 1, status: 1, departmentId: 1, createdAt: -1 });

/** 已批准 HC 下的职位；职位生命周期与候选申请分离。 */
@Schema({ collection: 'recruitment_positions', timestamps: true, versionKey: false, id: false })
export class RecruitmentPositionRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ ...STRING_ID, immutable: true })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  requisitionId!: string;

  @Prop({ type: String, required: true, minlength: 1, maxlength: 128 })
  title!: string;

  @Prop({ ...STRING_ID, immutable: true })
  departmentId!: string;

  @Prop({ ...STRING_ID, immutable: true })
  jobLevelId!: string;

  @Prop({ type: String, required: true, minlength: 1, maxlength: 128 })
  location!: string;

  @Prop({ type: Number, required: true, min: 1, max: 10_000 })
  headcount!: number;

  @Prop({ type: String, enum: ['draft', 'open', 'paused', 'closed'], required: true })
  status!: RecruitmentPositionStatus;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date, default: null })
  closedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecruitmentPositionDocument = HydratedDocument<RecruitmentPositionRecord>;
export const RecruitmentPositionRecordSchema = SchemaFactory.createForClass(RecruitmentPositionRecord);

RecruitmentPositionRecordSchema.pre('validate', function () {
  const record = this as RecruitmentPositionRecord;
  if (record.status === 'draft' && record.publishedAt !== null) {
    throw new Error('草稿职位不能存在发布时间');
  }
  if (record.status !== 'draft' && record.publishedAt === null) {
    throw new Error('已发布职位必须记录首次发布时间');
  }
  if ((record.status === 'closed') !== (record.closedAt !== null)) {
    throw new Error('职位关闭状态与关闭时间不一致');
  }
});

RecruitmentPositionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
RecruitmentPositionRecordSchema.index({ tenantId: 1, status: 1, departmentId: 1, createdAt: -1 });
RecruitmentPositionRecordSchema.index({ tenantId: 1, requisitionId: 1, createdAt: 1 });

/** 候选人对单一职位的一次申请事实；个人原文只存在候选人密文主档。 */
@Schema({ collection: 'recruitment_applications', timestamps: true, versionKey: false, id: false })
export class CandidateApplicationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ ...STRING_ID, immutable: true })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  candidateId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  positionId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: RECRUITMENT_CODE_PATTERN })
  sourceChannel!: string;

  @Prop({
    type: String,
    enum: APPLICATION_STAGES,
    required: true,
  })
  stage!: CandidateApplicationStage;

  @Prop({ type: Boolean, required: true })
  active!: boolean;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  completedInterviewId!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  offerId!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  acceptanceEvidenceId!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  onboardingInstanceId!: string | null;

  @Prop({ type: String, default: null, match: ULID_PATTERN })
  employmentId!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  @Prop({ type: Date, required: true, immutable: true })
  appliedAt!: Date;

  @Prop({ type: Date, default: null })
  endedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type CandidateApplicationDocument = HydratedDocument<CandidateApplicationRecord>;
export const CandidateApplicationRecordSchema = SchemaFactory.createForClass(CandidateApplicationRecord);

CandidateApplicationRecordSchema.pre('validate', function () {
  const record = this as CandidateApplicationRecord;
  const rank = applicationStageRank(record.stage);
  if (rank >= applicationStageRank('offer_approval') && record.completedInterviewId === null) {
    throw new Error('Offer 审批阶段必须引用已完成面试');
  }
  if (rank >= applicationStageRank('offer_sent') && record.offerId === null) {
    throw new Error('Offer 发送阶段必须引用 Offer');
  }
  if (rank >= applicationStageRank('offer_accepted') && record.acceptanceEvidenceId === null) {
    throw new Error('Offer 接受阶段必须引用接受证据');
  }
  if (rank >= applicationStageRank('preboarding') && record.onboardingInstanceId === null) {
    throw new Error('预入职阶段必须引用入职实例');
  }
  if (record.stage === 'hired' && record.employmentId === null) {
    throw new Error('已入职申请必须引用劳动关系');
  }
  if (TERMINAL_APPLICATION_STAGES.includes(record.stage) !== (record.endedAt !== null)) {
    throw new Error('申请终态与结束时间不一致');
  }
  if (record.active === TERMINAL_APPLICATION_STAGES.includes(record.stage)) {
    throw new Error('申请阶段与活动标志不一致');
  }
});

CandidateApplicationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CandidateApplicationRecordSchema.index({ tenantId: 1, candidateId: 1, appliedAt: -1 });
CandidateApplicationRecordSchema.index({ tenantId: 1, positionId: 1, stage: 1, appliedAt: -1 });
CandidateApplicationRecordSchema.index({ tenantId: 1, stage: 1, updatedAt: -1 });
CandidateApplicationRecordSchema.index(
  { tenantId: 1, candidateId: 1, positionId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

/** 申请阶段追加日志；唯一版本防止重复或乱序写入。 */
@Schema({ collection: 'recruitment_application_stage_events', timestamps: true, versionKey: false, id: false })
export class CandidateApplicationStageRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ ...STRING_ID, immutable: true })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  applicationId!: string;

  @Prop({ type: String, enum: APPLICATION_STAGES, required: true, immutable: true })
  from!: CandidateApplicationStage;

  @Prop({ type: String, enum: APPLICATION_STAGES, required: true, immutable: true })
  to!: CandidateApplicationStage;

  @Prop({ ...STRING_ID, immutable: true })
  actorId!: string;

  @Prop({ type: String, default: null, immutable: true, maxlength: 64, match: RECRUITMENT_CODE_PATTERN })
  reasonCode!: string | null;

  @Prop({ type: String, default: null, immutable: true, match: ULID_PATTERN })
  evidenceId!: string | null;

  @Prop({ type: Number, required: true, immutable: true, min: 2 })
  resultingVersion!: number;

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type CandidateApplicationStageDocument = HydratedDocument<CandidateApplicationStageRecord>;
export const CandidateApplicationStageRecordSchema = SchemaFactory.createForClass(CandidateApplicationStageRecord);

CandidateApplicationStageRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
CandidateApplicationStageRecordSchema.index(
  { tenantId: 1, applicationId: 1, resultingVersion: 1 },
  { unique: true },
);
CandidateApplicationStageRecordSchema.index({ tenantId: 1, applicationId: 1, occurredAt: 1 });

function applicationStageRank(stage: CandidateApplicationStage): number {
  const rank: Readonly<Record<CandidateApplicationStage, number>> = {
    applied: 0,
    screening: 1,
    interview: 2,
    rejected: 2,
    withdrawn: 2,
    offer_approval: 3,
    offer_sent: 4,
    offer_accepted: 5,
    preboarding: 6,
    hired: 7,
  };
  return rank[stage];
}
