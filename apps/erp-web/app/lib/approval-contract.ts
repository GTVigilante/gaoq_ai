export type ApprovalStatus = 'draft' | 'running' | 'approved' | 'rejected' | 'withdrawn' | 'archived';

export interface ApprovalSummary {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly riskLevel: 'R1' | 'R2';
  readonly version: number;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
}

export interface ApprovalView extends ApprovalSummary {
  readonly title: string;
  readonly initiatorId: string;
  readonly formData: Readonly<Record<string, unknown>>;
  readonly currentNodeIndex: number | null;
}

export interface ApprovalTimelineEntry {
  readonly actionId: string;
  readonly aggregateVersion: number;
  readonly actionType: 'instance.submitted' | 'instance.decided' | 'instance.approver_transferred' | 'instance.approver_added' | 'instance.withdrawn' | 'instance.archived';
  readonly actorId: string;
  readonly principalApproverId: string | null;
  readonly nodeId: string | null;
  readonly outcome: 'approved' | 'rejected' | null;
  readonly resultingStatus: ApprovalStatus | null;
  readonly delegated: boolean;
  readonly fromApproverId: string | null;
  readonly toApproverId: string | null;
  readonly addedApproverId: string | null;
  readonly canceledApproverIds: readonly string[];
  readonly occurredAt: string;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STATUSES = new Set<ApprovalStatus>(['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived']);

/** 在渲染前校验审批待办契约，拒绝未知状态和越界字段。 */
export function parseApprovalSummaries(value: unknown): readonly ApprovalSummary[] {
  if (!Array.isArray(value)) throw new Error('APPROVAL_LIST_INVALID');
  return Object.freeze(value.map((item) => parseApprovalSummary(item)));
}

/** 在渲染前校验审批详情契约。 */
export function parseApprovalView(value: unknown): ApprovalView {
  const summary = parseApprovalSummary(value);
  const record = objectRecord(value, 'APPROVAL_DETAIL_INVALID');
  if (
    typeof record.title !== 'string' || record.title.length < 1 || record.title.length > 256 ||
    typeof record.initiatorId !== 'string' || !ID_PATTERN.test(record.initiatorId) ||
    !isPlainObject(record.formData) ||
    !(record.currentNodeIndex === null || (Number.isSafeInteger(record.currentNodeIndex) && Number(record.currentNodeIndex) >= 0))
  ) throw new Error('APPROVAL_DETAIL_INVALID');
  return Object.freeze({
    ...summary,
    title: record.title,
    initiatorId: record.initiatorId,
    formData: Object.freeze({ ...record.formData }),
    currentNodeIndex: record.currentNodeIndex as number | null,
  });
}

/** 校验服务端追加式审批时间线；时间线不允许携带表单或租户字段。 */
export function parseApprovalTimeline(value: unknown): readonly ApprovalTimelineEntry[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('APPROVAL_TIMELINE_INVALID');
  return Object.freeze(value.map((item) => {
    const record = objectRecord(item, 'APPROVAL_TIMELINE_INVALID');
    const actionTypes: readonly ApprovalTimelineEntry['actionType'][] = [
      'instance.submitted', 'instance.decided', 'instance.approver_transferred',
      'instance.approver_added', 'instance.withdrawn', 'instance.archived',
    ];
    if (
      typeof record.actionId !== 'string' || !ULID_PATTERN.test(record.actionId) ||
      !positiveInteger(record.aggregateVersion) ||
      typeof record.actionType !== 'string' || !actionTypes.includes(record.actionType as ApprovalTimelineEntry['actionType']) ||
      typeof record.actorId !== 'string' || !ID_PATTERN.test(record.actorId) ||
      !nullableId(record.principalApproverId) || !nullableId(record.nodeId) ||
      !(record.outcome === null || record.outcome === 'approved' || record.outcome === 'rejected') ||
      !(record.resultingStatus === null || (typeof record.resultingStatus === 'string' && STATUSES.has(record.resultingStatus as ApprovalStatus))) ||
      typeof record.delegated !== 'boolean' ||
      !nullableId(record.fromApproverId) || !nullableId(record.toApproverId) || !nullableId(record.addedApproverId) ||
      !Array.isArray(record.canceledApproverIds) || record.canceledApproverIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id)) ||
      typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt)) ||
      Object.hasOwn(record, 'tenantId') || Object.hasOwn(record, 'formData')
    ) throw new Error('APPROVAL_TIMELINE_INVALID');
    return Object.freeze({
      actionId: record.actionId,
      aggregateVersion: record.aggregateVersion as number,
      actionType: record.actionType as ApprovalTimelineEntry['actionType'],
      actorId: record.actorId,
      principalApproverId: record.principalApproverId as string | null,
      nodeId: record.nodeId as string | null,
      outcome: record.outcome,
      resultingStatus: record.resultingStatus as ApprovalStatus | null,
      delegated: record.delegated,
      fromApproverId: record.fromApproverId as string | null,
      toApproverId: record.toApproverId as string | null,
      addedApproverId: record.addedApproverId as string | null,
      canceledApproverIds: Object.freeze([...(record.canceledApproverIds as string[])]),
      occurredAt: record.occurredAt,
    });
  }));
}

function parseApprovalSummary(value: unknown): ApprovalSummary {
  const record = objectRecord(value, 'APPROVAL_SUMMARY_INVALID');
  if (
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.status !== 'string' || !STATUSES.has(record.status as ApprovalStatus) ||
    typeof record.templateCode !== 'string' || !CODE_PATTERN.test(record.templateCode) ||
    !positiveInteger(record.templateRevision) ||
    (record.riskLevel !== 'R1' && record.riskLevel !== 'R2') ||
    !positiveInteger(record.version) ||
    !nullableIso(record.submittedAt) || !nullableIso(record.completedAt)
  ) throw new Error('APPROVAL_SUMMARY_INVALID');
  return Object.freeze({
    id: record.id,
    status: record.status as ApprovalStatus,
    templateCode: record.templateCode,
    templateRevision: record.templateRevision as number,
    riskLevel: record.riskLevel,
    version: record.version as number,
    submittedAt: record.submittedAt as string | null,
    completedAt: record.completedAt as string | null,
  });
}

function objectRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new Error(code);
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nullableIso(value: unknown): boolean {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function nullableId(value: unknown): boolean {
  return value === null || (typeof value === 'string' && ID_PATTERN.test(value));
}
