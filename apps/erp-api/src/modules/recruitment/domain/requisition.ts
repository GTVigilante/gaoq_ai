import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentId,
  assertRecruitmentLabel,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

export interface RecruitmentRequisition {
  readonly id: string;
  readonly tenantId: string;
  readonly departmentId: string;
  readonly positionTitle: string;
  readonly headcount: number;
  readonly justification: string;
  readonly status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'closed';
  readonly approvalInstanceId: string | null;
  readonly approvalHistoryId: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createRecruitmentRequisition(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly departmentId: string;
    readonly positionTitle: string;
    readonly headcount: number;
    readonly justification: string;
    readonly actorId: string;
  },
  now: Date,
): RecruitmentRequisition {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, departmentId: input.departmentId,
    actorId: input.actorId,
  })) assertRecruitmentId(value, field);
  assertRecruitmentLabel(input.positionTitle, 'positionTitle', 128);
  assertRecruitmentLabel(input.justification, 'justification', 4_096, 3);
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 1 || input.headcount > 10_000) {
    throw new RecruitmentDomainError('RECRUITMENT_HEADCOUNT_INVALID', 'HC 数量必须为 1..10000 的整数');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, departmentId: input.departmentId,
    positionTitle: input.positionTitle.trim(), headcount: input.headcount,
    justification: input.justification.trim(), status: 'draft' as const,
    approvalInstanceId: null, approvalHistoryId: null, version: 1, createdBy: input.actorId,
    createdAt: occurredAt, updatedAt: occurredAt,
  });
}

/** 绑定已创建的审批实例；仅建立引用，不在招聘模块复制审批状态机。 */
export function submitRecruitmentRequisition(
  requisition: RecruitmentRequisition,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly approvalInstanceId: string;
  },
  now: Date,
): RecruitmentRequisition {
  assertCommand(requisition, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.actorId, 'actorId');
  assertRecruitmentId(input.approvalInstanceId, 'approvalInstanceId');
  if (requisition.status !== 'draft' || requisition.createdBy !== input.actorId) {
    throw new RecruitmentDomainError('RECRUITMENT_REQUISITION_SUBMIT_DENIED', '只有创建人可提交 HC 草稿');
  }
  return advanceRequisition(requisition, now, {
    status: 'pending_approval' as const,
    approvalInstanceId: input.approvalInstanceId,
    approvalHistoryId: null,
  });
}

export interface RestoreRecruitmentRequisitionFromMigrationInput {
  readonly id: string;
  readonly tenantId: string;
  readonly departmentId: string;
  readonly positionTitle: string;
  readonly headcount: number;
  readonly justification: string;
  readonly status: RecruitmentRequisition['status'];
  readonly approvalInstanceId: string | null;
  readonly approvalHistoryId: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 数据迁移专用：恢复 HC 控制事实，不创建或推进审批。 */
export function restoreRecruitmentRequisitionFromMigration(
  input: RestoreRecruitmentRequisitionFromMigrationInput,
): RecruitmentRequisition {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    departmentId: input.departmentId,
    createdBy: input.createdBy,
  })) assertRecruitmentId(value, field);
  assertRecruitmentLabel(input.positionTitle, 'positionTitle', 128);
  assertRecruitmentLabel(input.justification, 'justification', 4_096, 3);
  assertRecruitmentVersion(input.version);
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 1 || input.headcount > 10_000) {
    throw new RecruitmentDomainError('RECRUITMENT_HEADCOUNT_INVALID', 'HC 数量必须为 1..10000 的整数');
  }
  if (!['draft', 'pending_approval', 'approved', 'rejected', 'closed'].includes(input.status)) {
    throw new RecruitmentDomainError('RECRUITMENT_REQUISITION_STATUS_INVALID', 'HC 迁移状态无效');
  }
  if (input.approvalInstanceId !== null) {
    assertRecruitmentId(input.approvalInstanceId, 'approvalInstanceId');
  }
  if (input.approvalHistoryId !== null) {
    assertRecruitmentId(input.approvalHistoryId, 'approvalHistoryId');
  }
  const referenceCount = Number(input.approvalInstanceId !== null) +
    Number(input.approvalHistoryId !== null);
  const referenceValid = input.status === 'draft'
    ? referenceCount === 0
    : input.status === 'pending_approval'
      ? input.approvalInstanceId !== null && input.approvalHistoryId === null
      : referenceCount === 1;
  const expectedVersion = input.status === 'draft'
    ? 1
    : input.status === 'pending_approval'
      ? 2
      : input.status === 'closed'
        ? 4
        : 3;
  if (!referenceValid || input.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_REQUISITION_MIGRATION_STATE_INVALID',
    'HC 迁移状态、审批引用与版本不一致',
  );
  const createdAt = strictMigrationIso(input.createdAt);
  const updatedAt = strictMigrationIso(input.updatedAt);
  if (updatedAt < createdAt) throw new RecruitmentDomainError(
    'RECRUITMENT_REQUISITION_MIGRATION_TIME_INVALID',
    'HC 更新时间不能早于创建时间',
  );
  return deepFreezeRecruitment({
    ...input,
    positionTitle: input.positionTitle.trim(),
    justification: input.justification.trim(),
    createdAt,
    updatedAt,
  });
}

/** 只接受 Approval 应用接口或领域事件已经验证的终态。 */
export function applyRecruitmentApprovalOutcome(
  requisition: RecruitmentRequisition,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly approvalInstanceId: string;
    readonly outcome: 'approved' | 'rejected';
    readonly approvalVerified: boolean;
  },
  now: Date,
): RecruitmentRequisition {
  assertCommand(requisition, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.approvalInstanceId, 'approvalInstanceId');
  if (input.outcome !== 'approved' && input.outcome !== 'rejected') {
    throw new RecruitmentDomainError(
      'RECRUITMENT_APPROVAL_OUTCOME_INVALID',
      'HC 审批结果必须为 approved 或 rejected',
    );
  }
  if (
    requisition.status !== 'pending_approval' || !input.approvalVerified ||
    requisition.approvalInstanceId !== input.approvalInstanceId
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_APPROVAL_EVIDENCE_INVALID', 'HC 审批结果缺少可信审批证据或引用不匹配',
  );
  return advanceRequisition(requisition, now, {
    status: input.outcome,
  });
}

export function closeRecruitmentRequisition(
  requisition: RecruitmentRequisition,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): RecruitmentRequisition {
  assertCommand(requisition, input.tenantId, input.expectedVersion);
  if (requisition.status !== 'approved') throw new RecruitmentDomainError(
    'RECRUITMENT_REQUISITION_CLOSE_INVALID', '只有已批准 HC 可以关闭',
  );
  return advanceRequisition(requisition, now, { status: 'closed' as const });
}

function assertCommand(
  requisition: RecruitmentRequisition,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentTenant(requisition.tenantId, tenantId);
  assertRecruitmentVersion(requisition.version);
  assertRecruitmentVersion(expectedVersion);
  if (requisition.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_VERSION_CONFLICT', 'HC 需求版本冲突',
  );
}

function advanceRequisition<T extends Partial<RecruitmentRequisition>>(
  requisition: RecruitmentRequisition,
  now: Date,
  patch: T,
): RecruitmentRequisition {
  const updatedAt = toRecruitmentIso(now);
  if (requisition.version >= Number.MAX_SAFE_INTEGER) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_REQUISITION_VERSION_EXHAUSTED',
      'HC 版本已达到安全整数上限',
    );
  }
  if (updatedAt < requisition.updatedAt) throw new RecruitmentDomainError(
    'RECRUITMENT_REQUISITION_TIMELINE_INVALID',
    'HC 更新时间不能早于当前版本',
  );
  return deepFreezeRecruitment({
    ...requisition,
    ...patch,
    version: requisition.version + 1,
    updatedAt,
  });
}

function strictMigrationIso(value: string): string {
  if (typeof value !== 'string') {
    throw new RecruitmentDomainError(
      'RECRUITMENT_REQUISITION_MIGRATION_TIME_INVALID',
      'HC 迁移时间必须为规范 UTC ISO 时间',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_REQUISITION_MIGRATION_TIME_INVALID',
      'HC 迁移时间必须为规范 UTC ISO 时间',
    );
  }
  return value;
}
