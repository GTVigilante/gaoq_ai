import { evaluateApprovalCondition, type ApprovalFormData } from './condition.js';
import { ApprovalDomainError } from './approval.errors.js';
import {
  hashApprovalJson,
  snapshotApprovalTemplate,
  type ApprovalProcessNode,
  type ApprovalTemplate,
  type ApprovalTemplateSnapshot,
  validateAndFreezeApprovalFormData,
} from './template.js';
import {
  assertApprovalId,
  assertPositiveVersion,
  assertSameTenant,
  assertUnique,
  toApprovalIso,
} from './approval.validation.js';

export type ApprovalInstanceStatus =
  | 'draft'
  | 'running'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'archived';

export interface ApprovalDecision {
  readonly principalApproverId: string;
  readonly decidedBy: string;
  readonly outcome: 'approved' | 'rejected';
  readonly decidedAt: string;
  readonly delegated: boolean;
}

export interface ResolvedApprovalNode {
  readonly id: string;
  readonly name: string;
  readonly type: 'approval' | 'copy';
  readonly approvalMode: 'all' | 'any' | null;
  readonly actorIds: readonly string[];
  readonly decisions: readonly ApprovalDecision[];
}

export interface ResolvedApprovalNodeInput {
  readonly nodeId: string;
  readonly actorIds: readonly string[];
}

export interface ApprovalInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly initiatorId: string;
  readonly status: ApprovalInstanceStatus;
  readonly templateSnapshot: ApprovalTemplateSnapshot;
  readonly formData: ApprovalFormData;
  readonly formDataHash: string;
  readonly resolvedNodes: readonly ResolvedApprovalNode[];
  readonly currentNodeIndex: number | null;
  readonly version: number;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ApprovalAction =
  | { readonly type: 'instance.submitted'; readonly actorId: string; readonly occurredAt: string }
  | {
      readonly type: 'instance.decided';
      readonly actorId: string;
      readonly principalApproverId: string;
      readonly delegated: boolean;
      readonly nodeId: string;
      readonly outcome: 'approved' | 'rejected';
      readonly resultingStatus: ApprovalInstanceStatus;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'instance.approver_transferred';
      readonly actorId: string;
      readonly nodeId: string;
      readonly fromApproverId: string;
      readonly toApproverId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'instance.approver_added';
      readonly actorId: string;
      readonly nodeId: string;
      readonly approverId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'instance.withdrawn';
      readonly actorId: string;
      readonly canceledApproverIds: readonly string[];
      readonly occurredAt: string;
    }
  | { readonly type: 'instance.archived'; readonly actorId: string; readonly occurredAt: string };

export interface ApprovalTransitionResult {
  readonly instance: ApprovalInstance;
  readonly action: ApprovalAction;
}

/** 从已发布模板创建草稿，并立即固定模板定义快照。 */
export function createApprovalInstanceDraft(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly title: string;
    readonly initiatorId: string;
    readonly template: ApprovalTemplate;
    readonly formData: ApprovalFormData;
  },
  now: Date,
): ApprovalInstance {
  assertApprovalId(input.id, 'id');
  assertApprovalId(input.tenantId, 'tenantId');
  assertApprovalId(input.initiatorId, 'initiatorId');
  assertSameTenant(input.tenantId, input.template.tenantId);
  if (input.title.trim().length < 1 || input.title.length > 256) {
    throw new ApprovalDomainError('APPROVAL_INSTANCE_TITLE_INVALID', '审批标题长度必须为 1..256');
  }
  const snapshot = snapshotApprovalTemplate(input.template);
  const formData = validateAndFreezeApprovalFormData(snapshot.definition, input.formData);
  const occurredAt = toApprovalIso(now);
  return deepFreeze({
    id: input.id,
    tenantId: input.tenantId,
    title: input.title.trim(),
    initiatorId: input.initiatorId,
    status: 'draft',
    templateSnapshot: snapshot,
    formData,
    formDataHash: hashApprovalJson(formData),
    resolvedNodes: [],
    currentNodeIndex: null,
    version: 1,
    submittedAt: null,
    completedAt: null,
    archivedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 草稿表单更新；已提交实例表单和模板快照永久冻结。 */
export function updateApprovalInstanceDraft(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly title: string;
    readonly formData: ApprovalFormData;
  },
  now: Date,
): ApprovalInstance {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (instance.status !== 'draft' || input.actorId !== instance.initiatorId) {
    throw new ApprovalDomainError('APPROVAL_DRAFT_UPDATE_DENIED', '只有发起人可以修改未提交草稿');
  }
  if (input.title.trim().length < 1 || input.title.length > 256) {
    throw new ApprovalDomainError('APPROVAL_INSTANCE_TITLE_INVALID', '审批标题长度必须为 1..256');
  }
  const formData = validateAndFreezeApprovalFormData(
    instance.templateSnapshot.definition,
    input.formData,
  );
  return deepFreeze({
    ...instance,
    title: input.title.trim(),
    formData,
    formDataHash: hashApprovalJson(formData),
    version: instance.version + 1,
    updatedAt: toApprovalIso(now),
  });
}

/** 提交审批：核对条件命中的节点集合和解析结果，冻结审批人快照。 */
export function submitApprovalInstance(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly resolvedNodes: readonly ResolvedApprovalNodeInput[];
  },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (instance.status !== 'draft' || input.actorId !== instance.initiatorId) {
    throw new ApprovalDomainError('APPROVAL_SUBMIT_DENIED', '只有发起人可以提交草稿');
  }
  const resolvedNodes = validateResolvedNodes(instance, input.resolvedNodes);
  const currentNodeIndex = findNextApprovalNode(resolvedNodes, -1);
  if (currentNodeIndex === null) {
    throw new ApprovalDomainError('APPROVAL_NO_ACTIVE_NODE', '流程没有可执行审批节点');
  }
  const occurredAt = toApprovalIso(now);
  const next = deepFreeze({
    ...instance,
    status: 'running' as const,
    resolvedNodes,
    currentNodeIndex,
    submittedAt: occurredAt,
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({ type: 'instance.submitted', actorId: input.actorId, occurredAt }),
  });
}

/** 当前节点审批；支持委托代理，但必须由应用层先验证有效委托关系。 */
export function decideApprovalInstance(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly principalApproverId: string;
    readonly delegationVerified: boolean;
    readonly outcome: 'approved' | 'rejected';
  },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  assertApprovalId(input.principalApproverId, 'principalApproverId');
  const nodeIndex = requireRunningNodeIndex(instance);
  const node = instance.resolvedNodes[nodeIndex];
  if (node === undefined || node.type !== 'approval' || node.approvalMode === null) {
    throw new ApprovalDomainError('APPROVAL_CURRENT_NODE_INVALID', '当前节点不是审批节点');
  }
  const delegated = input.actorId !== input.principalApproverId;
  if (delegated && !input.delegationVerified) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_REQUIRED', '代理审批必须验证有效委托');
  }
  if (!node.actorIds.includes(input.principalApproverId)) {
    throw new ApprovalDomainError('APPROVAL_ACTOR_DENIED', '当前主体不是该节点审批人');
  }
  if (node.decisions.some((decision) => decision.principalApproverId === input.principalApproverId)) {
    throw new ApprovalDomainError('APPROVAL_ALREADY_DECIDED', '该审批人已处理当前节点');
  }
  const occurredAt = toApprovalIso(now);
  const decision: ApprovalDecision = Object.freeze({
    principalApproverId: input.principalApproverId,
    decidedBy: input.actorId,
    outcome: input.outcome,
    decidedAt: occurredAt,
    delegated,
  });
  const updatedNode = deepFreeze({ ...node, decisions: [...node.decisions, decision] });
  const resolvedNodes = replaceNode(instance.resolvedNodes, nodeIndex, updatedNode);
  const transition = determineDecisionTransition(resolvedNodes, nodeIndex, updatedNode);
  const next = deepFreeze({
    ...instance,
    resolvedNodes,
    status: transition.status,
    currentNodeIndex: transition.currentNodeIndex,
    completedAt: transition.status === 'approved' || transition.status === 'rejected'
      ? occurredAt
      : instance.completedAt,
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({
      type: 'instance.decided', actorId: input.actorId,
      principalApproverId: input.principalApproverId, delegated,
      nodeId: node.id, outcome: input.outcome,
      resultingStatus: next.status, occurredAt,
    }),
  });
}

/** 转交当前待处理权限；已决策审批人不可转交，目标不可与现有审批人重复。 */
export function transferApprovalTask(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly fromApproverId: string;
    readonly toApproverId: string;
    readonly delegationVerified: boolean;
  },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  for (const [field, value] of Object.entries({
    actorId: input.actorId, fromApproverId: input.fromApproverId, toApproverId: input.toApproverId,
  })) assertApprovalId(value, field);
  const nodeIndex = requireRunningNodeIndex(instance);
  const node = instance.resolvedNodes[nodeIndex];
  if (node === undefined || node.type !== 'approval') {
    throw new ApprovalDomainError('APPROVAL_CURRENT_NODE_INVALID', '当前节点不是审批节点');
  }
  if (input.actorId !== input.fromApproverId && !input.delegationVerified) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_REQUIRED', '代理转交必须验证有效委托');
  }
  if (!node.actorIds.includes(input.fromApproverId)) {
    throw new ApprovalDomainError('APPROVAL_ACTOR_DENIED', '转交来源不是当前审批人');
  }
  if (node.decisions.some((decision) => decision.principalApproverId === input.fromApproverId)) {
    throw new ApprovalDomainError('APPROVAL_ALREADY_DECIDED', '已处理任务不能转交');
  }
  if (node.actorIds.includes(input.toApproverId)) {
    throw new ApprovalDomainError('APPROVAL_TRANSFER_DUPLICATE', '转交目标已是当前审批人');
  }
  assertR2Separation(instance, input.toApproverId);
  const updatedNode = deepFreeze({
    ...node,
    actorIds: node.actorIds.map((id) => id === input.fromApproverId ? input.toApproverId : id),
  });
  const occurredAt = toApprovalIso(now);
  const next = deepFreeze({
    ...instance,
    resolvedNodes: replaceNode(instance.resolvedNodes, nodeIndex, updatedNode),
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({
      type: 'instance.approver_transferred', actorId: input.actorId, nodeId: node.id,
      fromApproverId: input.fromApproverId, toApproverId: input.toApproverId, occurredAt,
    }),
  });
}

/** 当前会签节点加签；需由应用层验证加签权限，或签禁止加签以避免改变通过语义。 */
export function addApprovalSigner(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly approverId: string;
    readonly authorizationVerified: boolean;
  },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  assertApprovalId(input.approverId, 'approverId');
  if (!input.authorizationVerified) {
    throw new ApprovalDomainError('APPROVAL_ADD_SIGNER_DENIED', '加签需要服务端授权');
  }
  const nodeIndex = requireRunningNodeIndex(instance);
  const node = instance.resolvedNodes[nodeIndex];
  if (node === undefined || node.type !== 'approval' || node.approvalMode !== 'all') {
    throw new ApprovalDomainError('APPROVAL_ADD_SIGNER_MODE_DENIED', '仅当前会签节点允许加签');
  }
  if (node.actorIds.includes(input.approverId)) {
    throw new ApprovalDomainError('APPROVAL_ADD_SIGNER_DUPLICATE', '加签人已在当前节点');
  }
  assertR2Separation(instance, input.approverId);
  const updatedNode = deepFreeze({ ...node, actorIds: [...node.actorIds, input.approverId] });
  const occurredAt = toApprovalIso(now);
  const next = deepFreeze({
    ...instance,
    resolvedNodes: replaceNode(instance.resolvedNodes, nodeIndex, updatedNode),
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({
      type: 'instance.approver_added', actorId: input.actorId,
      nodeId: node.id, approverId: input.approverId, occurredAt,
    }),
  });
}

/** 发起人撤回草稿或运行中实例；终态不得回退。 */
export function withdrawApprovalInstance(
  instance: ApprovalInstance,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly actorId: string },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (input.actorId !== instance.initiatorId || !['draft', 'running'].includes(instance.status)) {
    throw new ApprovalDomainError('APPROVAL_WITHDRAW_DENIED', '当前审批不可由该主体撤回');
  }
  const activeNode = currentApprovalNode(instance);
  const decided = new Set(
    activeNode?.decisions.map((decision) => decision.principalApproverId) ?? [],
  );
  const canceledApproverIds = activeNode?.actorIds.filter((actorId) => !decided.has(actorId)) ?? [];
  const occurredAt = toApprovalIso(now);
  const next = deepFreeze({
    ...instance,
    status: 'withdrawn' as const,
    currentNodeIndex: null,
    completedAt: occurredAt,
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({
      type: 'instance.withdrawn',
      actorId: input.actorId,
      canceledApproverIds: Object.freeze(canceledApproverIds),
      occurredAt,
    }),
  });
}

/** 归档终态实例；归档不可逆且需要服务端确认的归档权限。 */
export function archiveApprovalInstance(
  instance: ApprovalInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly authorizationVerified: boolean;
  },
  now: Date,
): ApprovalTransitionResult {
  assertInstanceCommand(instance, input.tenantId, input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (!input.authorizationVerified || !['approved', 'rejected', 'withdrawn'].includes(instance.status)) {
    throw new ApprovalDomainError('APPROVAL_ARCHIVE_DENIED', '只有授权主体可以归档终态审批');
  }
  const occurredAt = toApprovalIso(now);
  const next = deepFreeze({
    ...instance,
    status: 'archived' as const,
    currentNodeIndex: null,
    archivedAt: occurredAt,
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    instance: next,
    action: Object.freeze({ type: 'instance.archived', actorId: input.actorId, occurredAt }),
  });
}

export function currentApprovalNode(instance: ApprovalInstance): ResolvedApprovalNode | null {
  return instance.currentNodeIndex === null
    ? null
    : instance.resolvedNodes[instance.currentNodeIndex] ?? null;
}

function validateResolvedNodes(
  instance: ApprovalInstance,
  inputs: readonly ResolvedApprovalNodeInput[],
): readonly ResolvedApprovalNode[] {
  if (!isArray(inputs)) {
    throw new ApprovalDomainError('APPROVAL_RESOLUTION_INVALID', '审批人解析结果必须为数组');
  }
  if (inputs.some((input) => !isPlainObject(input))) {
    throw new ApprovalDomainError('APPROVAL_RESOLUTION_INVALID', '审批人解析项必须为纯对象');
  }
  assertUnique(inputs.map((input) => input.nodeId), 'resolvedNodes.nodeId');
  const fieldKeys = new Set(instance.templateSnapshot.definition.fields.map((field) => field.key));
  const expected = instance.templateSnapshot.definition.nodes.filter((node) =>
    node.condition === undefined ||
    evaluateApprovalCondition(node.condition, instance.formData, fieldKeys),
  );
  if (inputs.length !== expected.length) {
    throw new ApprovalDomainError('APPROVAL_RESOLUTION_MISMATCH', '审批人解析结果与条件命中节点不一致');
  }
  return deepFreeze(expected.map((node) => resolveNode(instance, node, inputs)));
}

function resolveNode(
  instance: ApprovalInstance,
  node: ApprovalProcessNode,
  inputs: readonly ResolvedApprovalNodeInput[],
): ResolvedApprovalNode {
  const input = inputs.find((candidate) => candidate.nodeId === node.id);
  const minimumActors = node.type === 'approval' ? 1 : 0;
  if (
    input === undefined || !isArray(input.actorIds) || input.actorIds.length < minimumActors ||
    input.actorIds.length > 100
  ) {
    throw new ApprovalDomainError('APPROVAL_RESOLUTION_INVALID', `节点 ${node.id} 解析结果无效`);
  }
  for (const actorId of input.actorIds) assertApprovalId(actorId, 'resolvedActorId');
  assertUnique(input.actorIds, `resolvedNodes.${node.id}.actorIds`);
  if (node.type === 'approval') {
    for (const approverId of input.actorIds) assertR2Separation(instance, approverId);
  }
  return deepFreeze({
    id: node.id,
    name: node.name,
    type: node.type,
    approvalMode: node.approvalMode ?? null,
    actorIds: [...input.actorIds],
    decisions: [],
  });
}

function determineDecisionTransition(
  nodes: readonly ResolvedApprovalNode[],
  nodeIndex: number,
  node: ResolvedApprovalNode,
): { readonly status: ApprovalInstanceStatus; readonly currentNodeIndex: number | null } {
  const approvals = node.decisions.filter((decision) => decision.outcome === 'approved').length;
  const rejections = node.decisions.filter((decision) => decision.outcome === 'rejected').length;
  if (node.approvalMode === 'all' && rejections > 0) {
    return { status: 'rejected', currentNodeIndex: null };
  }
  if (node.approvalMode === 'any' && approvals === 0 && rejections === node.actorIds.length) {
    return { status: 'rejected', currentNodeIndex: null };
  }
  const passed = node.approvalMode === 'all'
    ? approvals === node.actorIds.length
    : approvals > 0;
  if (!passed) return { status: 'running', currentNodeIndex: nodeIndex };
  const nextNodeIndex = findNextApprovalNode(nodes, nodeIndex);
  return nextNodeIndex === null
    ? { status: 'approved', currentNodeIndex: null }
    : { status: 'running', currentNodeIndex: nextNodeIndex };
}

function findNextApprovalNode(
  nodes: readonly ResolvedApprovalNode[],
  afterIndex: number,
): number | null {
  for (let index = afterIndex + 1; index < nodes.length; index += 1) {
    if (nodes[index]?.type === 'approval') return index;
  }
  return null;
}

function requireRunningNodeIndex(instance: ApprovalInstance): number {
  if (instance.status !== 'running' || instance.currentNodeIndex === null) {
    throw new ApprovalDomainError('APPROVAL_NOT_RUNNING', '审批实例不在运行状态');
  }
  return instance.currentNodeIndex;
}

function replaceNode(
  nodes: readonly ResolvedApprovalNode[],
  index: number,
  node: ResolvedApprovalNode,
): readonly ResolvedApprovalNode[] {
  return nodes.map((current, currentIndex) => currentIndex === index ? node : current);
}

function assertInstanceCommand(
  instance: ApprovalInstance,
  tenantId: string,
  expectedVersion: number,
): void {
  assertSameTenant(instance.tenantId, tenantId);
  assertPositiveVersion(expectedVersion, 'expectedVersion');
  if (instance.version !== expectedVersion) {
    throw new ApprovalDomainError('APPROVAL_VERSION_CONFLICT', '审批实例版本冲突');
  }
}

function assertR2Separation(instance: ApprovalInstance, approverId: string): void {
  if (instance.templateSnapshot.riskLevel === 'R2' && approverId === instance.initiatorId) {
    throw new ApprovalDomainError('APPROVAL_R2_SELF_APPROVAL_DENIED', 'R2 审批禁止发起人自批');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
