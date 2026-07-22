import type { ApprovalAction, ApprovalInstance } from './instance.js';
import type { ApprovalTemplate } from './template.js';
import type { ApprovalDelegation } from './delegation.js';
import type { ApprovalLegacyHistory } from './legacy-history.js';

export interface ApprovalEvent<TType extends string, TPayload extends Record<string, unknown>> {
  readonly type: TType;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export type ApprovalDomainEvent =
  | ApprovalEvent<'approval_template.draft_created', {
      readonly code: string; readonly revision: number; readonly riskLevel: 'R1' | 'R2';
      readonly definitionHash: string;
    }>
  | ApprovalEvent<'approval_template.published', {
      readonly code: string; readonly revision: number; readonly riskLevel: 'R1' | 'R2';
      readonly definitionHash: string; readonly approvedBy: string;
    }>
  | ApprovalEvent<'approval_template.retired', {
      readonly code: string; readonly revision: number;
    }>
  | ApprovalEvent<'approval_template.migrated', {
      readonly code: string; readonly revision: number; readonly status: ApprovalTemplate['status'];
      readonly riskLevel: 'R1' | 'R2'; readonly definitionHash: string;
    }>
  | ApprovalEvent<'approval_history.migrated', {
      readonly templateCode: string; readonly templateRevision: number;
      readonly outcome: ApprovalLegacyHistory['outcome']; readonly evidenceChecksum: string;
    }>
  | ApprovalEvent<'approval_instance.draft_created', {
      readonly initiatorId: string; readonly templateCode: string; readonly templateRevision: number;
      readonly riskLevel: 'R1' | 'R2'; readonly formDataHash: string;
    }>
  | ApprovalEvent<'approval_instance.migrated', {
      readonly status: 'draft' | 'running'; readonly templateCode: string;
      readonly templateRevision: number; readonly riskLevel: 'R1' | 'R2';
      readonly formDataHash: string; readonly actionCount: number;
      readonly evidenceChecksum: string;
    }>
  | ApprovalEvent<'approval_instance.submitted', {
      readonly actorId: string;
    }>
  | ApprovalEvent<'approval_instance.decided', {
      readonly actorId: string; readonly principalApproverId: string; readonly delegated: boolean;
      readonly nodeId: string; readonly outcome: 'approved' | 'rejected'; readonly resultingStatus: string;
    }>
  | ApprovalEvent<'approval_instance.approver_transferred', {
      readonly actorId: string; readonly nodeId: string; readonly fromApproverId: string;
      readonly toApproverId: string;
    }>
  | ApprovalEvent<'approval_instance.approver_added', {
      readonly actorId: string; readonly nodeId: string; readonly approverId: string;
    }>
  | ApprovalEvent<'approval_instance.withdrawn', {
      readonly actorId: string;
      readonly canceledApproverIds: readonly string[];
    }>
  | ApprovalEvent<'approval_instance.archived', { readonly actorId: string }>
  | ApprovalEvent<'approval_delegation.created', {
      readonly principalApproverId: string; readonly delegateId: string;
      readonly validFrom: string; readonly validUntil: string;
    }>
  | ApprovalEvent<'approval_delegation.revoked', {
      readonly principalApproverId: string; readonly delegateId: string; readonly revokedBy: string;
    }>;

/** 委托事件只披露授权主体、代理主体和有效期，不包含权限快照或组织数据。 */
export function buildApprovalDelegationEvent(
  delegation: ApprovalDelegation,
  type: 'created' | 'revoked',
): ApprovalDomainEvent {
  const common = {
    tenantId: delegation.tenantId,
    aggregateId: delegation.id,
    version: delegation.version,
    occurredAt: delegation.updatedAt,
  };
  if (type === 'created') return {
    ...common,
    type: 'approval_delegation.created',
    payload: {
      principalApproverId: delegation.principalApproverId,
      delegateId: delegation.delegateId,
      validFrom: delegation.validFrom,
      validUntil: delegation.validUntil,
    },
  };
  if (delegation.revokedBy === null) throw new Error('委托撤销事件缺少撤销主体');
  return {
    ...common,
    type: 'approval_delegation.revoked',
    payload: {
      principalApproverId: delegation.principalApproverId,
      delegateId: delegation.delegateId,
      revokedBy: delegation.revokedBy,
    },
  };
}

/** 模板事件只披露版本元数据和摘要，不外发字段定义。 */
export function buildApprovalTemplateEvent(
  template: ApprovalTemplate,
  type: 'draft_created' | 'published' | 'retired',
): ApprovalDomainEvent {
  const common = {
    tenantId: template.tenantId,
    aggregateId: template.id,
    version: template.version,
    occurredAt: template.updatedAt,
  };
  if (type === 'draft_created') {
    return {
      ...common,
      type: 'approval_template.draft_created',
      payload: {
        code: template.code, revision: template.revision, riskLevel: template.riskLevel,
        definitionHash: template.definitionHash,
      },
    };
  }
  if (type === 'published') {
    if (template.approvedBy === null) throw new Error('发布事件缺少审批人');
    return {
      ...common,
      type: 'approval_template.published',
      payload: {
        code: template.code, revision: template.revision, riskLevel: template.riskLevel,
        definitionHash: template.definitionHash, approvedBy: template.approvedBy,
      },
    };
  }
  return {
    ...common,
    type: 'approval_template.retired',
    payload: { code: template.code, revision: template.revision },
  };
}

/** 迁移事件只披露模板控制元数据，不伪装成发布或退役动作。 */
export function buildApprovalTemplateMigratedEvent(
  template: ApprovalTemplate,
): ApprovalDomainEvent {
  return {
    type: 'approval_template.migrated',
    tenantId: template.tenantId,
    aggregateId: template.id,
    version: template.version,
    occurredAt: template.updatedAt,
    payload: {
      code: template.code,
      revision: template.revision,
      status: template.status,
      riskLevel: template.riskLevel,
      definitionHash: template.definitionHash,
    },
  };
}

/** 旧审批历史迁移事件只披露检索元数据和证据摘要，不外发表单、意见或附件定位符。 */
export function buildApprovalLegacyHistoryMigratedEvent(
  history: ApprovalLegacyHistory,
): ApprovalDomainEvent {
  return {
    type: 'approval_history.migrated',
    tenantId: history.tenantId,
    aggregateId: history.id,
    version: history.version,
    occurredAt: history.createdAt,
    payload: {
      templateCode: history.templateCode,
      templateRevision: history.templateRevision,
      outcome: history.outcome,
      evidenceChecksum: history.evidenceChecksum,
    },
  };
}

/** 实例草稿事件不含标题和表单正文。 */
export function buildApprovalInstanceCreatedEvent(instance: ApprovalInstance): ApprovalDomainEvent {
  return {
    type: 'approval_instance.draft_created',
    tenantId: instance.tenantId,
    aggregateId: instance.id,
    version: instance.version,
    occurredAt: instance.createdAt,
    payload: {
      initiatorId: instance.initiatorId,
      templateCode: instance.templateSnapshot.templateCode,
      templateRevision: instance.templateSnapshot.revision,
      riskLevel: instance.templateSnapshot.riskLevel,
      formDataHash: instance.formDataHash,
    },
  };
}

/** 活动实例迁移事件只披露状态、模板和摘要，不伪装成提交/决策动作。 */
export function buildApprovalInstanceMigratedEvent(
  instance: ApprovalInstance,
  actionCount: number,
  evidenceChecksum: string,
): ApprovalDomainEvent {
  if (!['draft', 'running'].includes(instance.status)) {
    throw new Error('活动审批迁移事件只允许草稿或运行中状态');
  }
  return {
    type: 'approval_instance.migrated',
    tenantId: instance.tenantId,
    aggregateId: instance.id,
    version: instance.version,
    occurredAt: instance.updatedAt,
    payload: {
      status: instance.status as 'draft' | 'running',
      templateCode: instance.templateSnapshot.templateCode,
      templateRevision: instance.templateSnapshot.revision,
      riskLevel: instance.templateSnapshot.riskLevel,
      formDataHash: instance.formDataHash,
      actionCount,
      evidenceChecksum,
    },
  };
}

/** 将领域动作转换为最小披露事件；表单正文永不进入 Outbox。 */
export function buildApprovalActionEvent(
  instance: ApprovalInstance,
  action: ApprovalAction,
): ApprovalDomainEvent {
  const common = {
    tenantId: instance.tenantId,
    aggregateId: instance.id,
    version: instance.version,
    occurredAt: action.occurredAt,
  };
  switch (action.type) {
    case 'instance.submitted':
      return { ...common, type: 'approval_instance.submitted', payload: { actorId: action.actorId } };
    case 'instance.decided':
      return {
        ...common,
        type: 'approval_instance.decided',
        payload: {
          actorId: action.actorId, principalApproverId: action.principalApproverId,
          delegated: action.delegated, nodeId: action.nodeId, outcome: action.outcome,
          resultingStatus: action.resultingStatus,
        },
      };
    case 'instance.approver_transferred':
      return {
        ...common,
        type: 'approval_instance.approver_transferred',
        payload: {
          actorId: action.actorId, nodeId: action.nodeId,
          fromApproverId: action.fromApproverId, toApproverId: action.toApproverId,
        },
      };
    case 'instance.approver_added':
      return {
        ...common,
        type: 'approval_instance.approver_added',
        payload: { actorId: action.actorId, nodeId: action.nodeId, approverId: action.approverId },
      };
    case 'instance.withdrawn':
      return {
        ...common,
        type: 'approval_instance.withdrawn',
        payload: {
          actorId: action.actorId,
          canceledApproverIds: action.canceledApproverIds,
        },
      };
    case 'instance.archived':
      return { ...common, type: 'approval_instance.archived', payload: { actorId: action.actorId } };
  }
}
