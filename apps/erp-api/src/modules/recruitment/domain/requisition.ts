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
  assertRecruitmentLabel(input.justification, 'justification', 4_096);
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 1 || input.headcount > 10_000) {
    throw new RecruitmentDomainError('RECRUITMENT_HEADCOUNT_INVALID', 'HC 数量必须为 1..10000 的整数');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, departmentId: input.departmentId,
    positionTitle: input.positionTitle.trim(), headcount: input.headcount,
    justification: input.justification.trim(), status: 'draft' as const,
    approvalInstanceId: null, version: 1, createdBy: input.actorId,
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
  return deepFreezeRecruitment({
    ...requisition,
    status: 'pending_approval' as const,
    approvalInstanceId: input.approvalInstanceId,
    version: requisition.version + 1,
    updatedAt: toRecruitmentIso(now),
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
  if (
    requisition.status !== 'pending_approval' || !input.approvalVerified ||
    requisition.approvalInstanceId !== input.approvalInstanceId
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_APPROVAL_EVIDENCE_INVALID', 'HC 审批结果缺少可信审批证据或引用不匹配',
  );
  return deepFreezeRecruitment({
    ...requisition,
    status: input.outcome,
    version: requisition.version + 1,
    updatedAt: toRecruitmentIso(now),
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
  return deepFreezeRecruitment({
    ...requisition, status: 'closed' as const, version: requisition.version + 1,
    updatedAt: toRecruitmentIso(now),
  });
}

function assertCommand(
  requisition: RecruitmentRequisition,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentTenant(requisition.tenantId, tenantId);
  assertRecruitmentVersion(expectedVersion);
  if (requisition.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_VERSION_CONFLICT', 'HC 需求版本冲突',
  );
}
