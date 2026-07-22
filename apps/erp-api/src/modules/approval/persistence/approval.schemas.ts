import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import { approvalDelegationCoverageDays } from '../domain/delegation.js';
import type { ApprovalInstanceStatus } from '../domain/instance.js';
import type { LegacyApprovalOutcome } from '../domain/legacy-history.js';
import type { ApprovalTemplateStatus } from '../domain/template.js';

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_DEFINITION_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_SNAPSHOT_JSON_LENGTH = 4 * 1024 * 1024;
const MAX_RESOLVED_NODES_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_CIPHERTEXT_LENGTH = 8 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JSON_OBJECT_PATTERN = /^\s*\{/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

const hasUniqueElements = (value: string[]): boolean =>
  Array.isArray(value) && new Set(value).size === value.length;

/** 审批模板版本记录；definitionJson 是领域层已验证并冻结的完整定义。 */
@Schema({ collection: 'approval_templates', timestamps: true, versionKey: false, id: false })
export class ApprovalTemplateRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64 })
  code!: string;

  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  name!: string;

  @Prop({ type: String, enum: ['R1', 'R2'], required: true })
  riskLevel!: 'R1' | 'R2';

  @Prop({ type: Number, required: true, immutable: true, validate: isPositiveSafeInteger })
  revision!: number;

  @Prop({ type: String, enum: ['draft', 'published', 'retired'], required: true })
  status!: ApprovalTemplateStatus;

  @Prop({
    type: String, required: true, maxlength: MAX_DEFINITION_JSON_LENGTH,
    match: [JSON_OBJECT_PATTERN, 'definitionJson 必须是 JSON 对象'],
  })
  definitionJson!: string;

  @Prop({ type: String, required: true, match: SHA256_BASE64URL_PATTERN })
  definitionHash!: string;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  approvedBy!: string | null;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date, default: null })
  retiredAt!: Date | null;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  version!: number;

  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  createdBy!: string;

  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  updatedBy!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ApprovalTemplateDocument = HydratedDocument<ApprovalTemplateRecord>;
export const ApprovalTemplateRecordSchema = SchemaFactory.createForClass(ApprovalTemplateRecord);

ApprovalTemplateRecordSchema.pre('validate', function () {
  const record = this as ApprovalTemplateRecord;
  if (record.status === 'draft' && (record.approvedBy !== null || record.publishedAt !== null)) {
    throw new Error('草稿模板不能包含发布审批信息');
  }
  if (record.status !== 'draft' && (record.approvedBy === null || record.publishedAt === null)) {
    throw new Error('已发布或退役模板必须包含审批人与发布时间');
  }
  if (record.status !== 'retired' && record.retiredAt !== null) {
    throw new Error('未退役模板不能包含退役时间');
  }
  if (record.status === 'retired' && record.retiredAt === null) {
    throw new Error('退役模板必须包含退役时间');
  }
});

ApprovalTemplateRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ApprovalTemplateRecordSchema.index({ tenantId: 1, code: 1, revision: 1 }, { unique: true });
ApprovalTemplateRecordSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
ApprovalTemplateRecordSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { status: 'draft' }, name: 'one_draft_per_code' },
);
ApprovalTemplateRecordSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { status: 'published' }, name: 'one_published_per_code' },
);

/** 已终结旧审批的最小不可变索引；正文与动作材料只存在于 WORM 迁移证据。 */
@Schema({ collection: 'approval_legacy_histories', timestamps: true, versionKey: false, id: false })
export class ApprovalLegacyHistoryRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  templateId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64 })
  templateCode!: string;

  @Prop({ type: Number, required: true, immutable: true, validate: isPositiveSafeInteger })
  templateRevision!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  initiatorEmployeeId!: string;

  @Prop({
    type: String,
    enum: ['approved', 'rejected', 'withdrawn'],
    required: true,
    immutable: true,
  })
  outcome!: LegacyApprovalOutcome;

  @Prop({ type: Date, required: true, immutable: true })
  completedAt!: Date;

  @Prop({ type: Date, default: null, immutable: true })
  archivedAt!: Date | null;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    maxlength: 320,
    match: MIGRATION_EVIDENCE_REF_PATTERN,
  })
  migrationEvidenceRef!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: SHA256_BASE64URL_PATTERN,
  })
  evidenceChecksum!: string;

  @Prop({ type: Number, required: true, immutable: true, enum: [1] })
  version!: 1;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ApprovalLegacyHistoryDocument = HydratedDocument<ApprovalLegacyHistoryRecord>;
export const ApprovalLegacyHistoryRecordSchema = SchemaFactory.createForClass(
  ApprovalLegacyHistoryRecord,
);
ApprovalLegacyHistoryRecordSchema.pre('validate', function validateLegacyHistory() {
  if (this.archivedAt !== null && this.archivedAt.getTime() < this.completedAt.getTime()) {
    this.invalidate('archivedAt', '归档时间不能早于完成时间');
  }
});
ApprovalLegacyHistoryRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ApprovalLegacyHistoryRecordSchema.index(
  { tenantId: 1, migrationEvidenceRef: 1 },
  { unique: true },
);
ApprovalLegacyHistoryRecordSchema.index({ tenantId: 1, templateCode: 1, completedAt: -1 });

/** 审批实例记录；表单正文只允许加密字段，禁止明文 JSON 落库。 */
@Schema({ collection: 'approval_instances', timestamps: true, versionKey: false, id: false })
export class ApprovalInstanceRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, maxlength: MAX_NAME_LENGTH })
  title!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  initiatorId!: string;

  @Prop({
    type: String,
    enum: ['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived'],
    required: true,
  })
  status!: ApprovalInstanceStatus;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  templateId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 64 })
  templateCode!: string;

  @Prop({ type: Number, required: true, immutable: true, validate: isPositiveSafeInteger })
  templateRevision!: number;

  @Prop({ type: String, enum: ['R1', 'R2'], required: true, immutable: true })
  riskLevel!: 'R1' | 'R2';

  @Prop({
    type: String, required: true, immutable: true, maxlength: MAX_SNAPSHOT_JSON_LENGTH,
    match: [JSON_OBJECT_PATTERN, 'templateSnapshotJson 必须是 JSON 对象'],
  })
  templateSnapshotJson!: string;

  @Prop({ type: String, required: true, match: SHA256_BASE64URL_PATTERN })
  formDataHash!: string;

  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  formDataKeyId!: string;

  @Prop({ type: String, required: true, match: BASE64URL_PATTERN, maxlength: 32 })
  formDataIv!: string;

  @Prop({ type: String, required: true, match: BASE64URL_PATTERN, maxlength: MAX_CIPHERTEXT_LENGTH })
  formDataCiphertext!: string;

  @Prop({ type: String, required: true, match: BASE64URL_PATTERN, maxlength: 32 })
  formDataAuthTag!: string;

  @Prop({
    type: String, required: true, maxlength: MAX_RESOLVED_NODES_JSON_LENGTH,
    match: [JSON_OBJECT_PATTERN, 'resolvedNodesJson 必须是包装后的 JSON 对象'],
  })
  resolvedNodesJson!: string;

  @Prop({ type: Number, default: null, min: 0, max: 49 })
  currentNodeIndex!: number | null;

  @Prop({
    type: [{ type: String, maxlength: MAX_ID_LENGTH }], required: true, default: [],
    validate: { validator: hasUniqueElements, message: 'currentActorIds 不得重复' },
  })
  currentActorIds!: string[];

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  version!: number;

  @Prop({ type: Date, default: null })
  submittedAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ApprovalInstanceDocument = HydratedDocument<ApprovalInstanceRecord>;
export const ApprovalInstanceRecordSchema = SchemaFactory.createForClass(ApprovalInstanceRecord);

ApprovalInstanceRecordSchema.pre('validate', function () {
  const record = this as ApprovalInstanceRecord;
  if (record.status === 'draft') {
    if (record.currentNodeIndex !== null || record.currentActorIds.length !== 0 || record.submittedAt !== null) {
      throw new Error('草稿审批不能包含运行态字段');
    }
    return;
  }
  if (record.status === 'running') {
    if (
      record.currentNodeIndex === null || record.currentActorIds.length < 1 ||
      record.submittedAt === null || record.completedAt !== null
    ) throw new Error('运行中审批的当前节点字段不完整');
    return;
  }
  if (record.currentNodeIndex !== null || record.currentActorIds.length !== 0) {
    throw new Error('审批终态不能保留当前待办');
  }
  if (record.completedAt === null) {
    throw new Error('审批业务终态必须包含完成时间');
  }
  if (
    (record.status === 'approved' || record.status === 'rejected') && record.submittedAt === null
  ) throw new Error('审批通过或拒绝必须包含提交时间');
  if (record.status === 'archived' && record.archivedAt === null) {
    throw new Error('归档审批必须包含归档时间');
  }
});

ApprovalInstanceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ApprovalInstanceRecordSchema.index({ tenantId: 1, initiatorId: 1, createdAt: -1 });
ApprovalInstanceRecordSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
ApprovalInstanceRecordSchema.index({ tenantId: 1, status: 1, completedAt: -1 });
ApprovalInstanceRecordSchema.index({ tenantId: 1, status: 1, submittedAt: -1 });
ApprovalInstanceRecordSchema.index({ tenantId: 1, currentActorIds: 1, status: 1, updatedAt: -1 });
ApprovalInstanceRecordSchema.index({ tenantId: 1, templateCode: 1, createdAt: -1 });

export type ApprovalActionType =
  | 'instance.submitted'
  | 'instance.decided'
  | 'instance.approver_transferred'
  | 'instance.approver_added'
  | 'instance.withdrawn'
  | 'instance.archived';

/** 审批动作追加日志；只保存标识和状态，不保存表单正文。 */
@Schema({ collection: 'approval_actions', timestamps: false, versionKey: false, id: false })
export class ApprovalActionRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  actionId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  instanceId!: string;

  @Prop({ type: Number, required: true, immutable: true, validate: isPositiveSafeInteger })
  aggregateVersion!: number;

  @Prop({
    type: String,
    enum: [
      'instance.submitted', 'instance.decided', 'instance.approver_transferred',
      'instance.approver_added', 'instance.withdrawn', 'instance.archived',
    ],
    required: true,
    immutable: true,
  })
  actionType!: ApprovalActionType;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  actorId!: string;

  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID_LENGTH })
  principalApproverId!: string | null;

  @Prop({ type: String, default: null, immutable: true, maxlength: 64 })
  nodeId!: string | null;

  @Prop({ type: String, enum: ['approved', 'rejected', null], default: null, immutable: true })
  outcome!: 'approved' | 'rejected' | null;

  @Prop({
    type: String,
    enum: ['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived', null],
    default: null,
    immutable: true,
  })
  resultingStatus!: ApprovalInstanceStatus | null;

  @Prop({ type: Boolean, required: true, default: false, immutable: true })
  delegated!: boolean;

  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID_LENGTH })
  fromApproverId!: string | null;

  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID_LENGTH })
  toApproverId!: string | null;

  @Prop({ type: String, default: null, immutable: true, maxlength: MAX_ID_LENGTH })
  addedApproverId!: string | null;

  @Prop({
    type: [{ type: String, maxlength: MAX_ID_LENGTH }], required: true, default: [], immutable: true,
    validate: { validator: hasUniqueElements, message: 'canceledApproverIds 不得重复' },
  })
  canceledApproverIds!: string[];

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;
}

export type ApprovalActionDocument = HydratedDocument<ApprovalActionRecord>;
export const ApprovalActionRecordSchema = SchemaFactory.createForClass(ApprovalActionRecord);

ApprovalActionRecordSchema.pre('validate', function () {
  const record = this as ApprovalActionRecord;
  if (record.actionType === 'instance.decided') {
    if (
      record.nodeId === null || record.principalApproverId === null || record.outcome === null ||
      record.resultingStatus === null
    ) throw new Error('审批决策动作字段不完整');
  } else if (record.outcome !== null || record.principalApproverId !== null || record.delegated) {
    throw new Error('非决策动作不能包含决策字段');
  }
  if (
    record.actionType === 'instance.approver_transferred' &&
    (record.nodeId === null || record.fromApproverId === null || record.toApproverId === null)
  ) throw new Error('转交动作字段不完整');
  if (
    record.actionType === 'instance.approver_added' &&
    (record.nodeId === null || record.addedApproverId === null)
  ) throw new Error('加签动作字段不完整');
  if (record.actionType !== 'instance.withdrawn' && record.canceledApproverIds.length > 0) {
    throw new Error('非撤回动作不能包含取消审批人');
  }
});

ApprovalActionRecordSchema.index({ actionId: 1 }, { unique: true });
ApprovalActionRecordSchema.index(
  { tenantId: 1, instanceId: 1, aggregateVersion: 1 },
  { unique: true },
);
ApprovalActionRecordSchema.index({ tenantId: 1, actorId: 1, occurredAt: -1 });

/** 服务端验证的审批委托关系。 */
@Schema({ collection: 'approval_delegations', timestamps: true, versionKey: false, id: false })
export class ApprovalDelegationRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  principalApproverId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: MAX_ID_LENGTH })
  delegateId!: string;

  @Prop({ type: Date, required: true, immutable: true })
  validFrom!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  validUntil!: Date;

  @Prop({ type: [String], required: true, immutable: true })
  coverageDays!: string[];

  @Prop({ type: String, enum: ['active', 'revoked'], required: true, default: 'active' })
  status!: 'active' | 'revoked';

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  version!: number;

  @Prop({ type: String, required: true, maxlength: MAX_ID_LENGTH })
  createdBy!: string;

  @Prop({ type: String, default: null, maxlength: MAX_ID_LENGTH })
  revokedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ApprovalDelegationDocument = HydratedDocument<ApprovalDelegationRecord>;
export const ApprovalDelegationRecordSchema = SchemaFactory.createForClass(ApprovalDelegationRecord);

ApprovalDelegationRecordSchema.pre('validate', function () {
  const record = this as ApprovalDelegationRecord;
  if (record.principalApproverId === record.delegateId) {
    throw new Error('审批委托人与代理人不能相同');
  }
  if (record.validUntil.getTime() <= record.validFrom.getTime()) {
    throw new Error('审批委托截止时间必须晚于开始时间');
  }
  const expectedDays = approvalDelegationCoverageDays(
    record.validFrom.toISOString(), record.validUntil.toISOString(),
  );
  if (
    record.coverageDays.length !== expectedDays.length ||
    record.coverageDays.some((day, index) => day !== expectedDays[index])
  ) throw new Error('审批委托覆盖日槽无效');
  if (record.status === 'revoked' && record.revokedBy === null) {
    throw new Error('已撤销委托必须记录撤销人');
  }
  if (record.status === 'active' && record.revokedBy !== null) {
    throw new Error('有效委托不能包含撤销人');
  }
});

ApprovalDelegationRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ApprovalDelegationRecordSchema.index({
  tenantId: 1, principalApproverId: 1, delegateId: 1, status: 1, validFrom: 1, validUntil: 1,
});
ApprovalDelegationRecordSchema.index({ tenantId: 1, delegateId: 1, status: 1, validUntil: 1 });
ApprovalDelegationRecordSchema.index(
  { tenantId: 1, principalApproverId: 1, coverageDays: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
