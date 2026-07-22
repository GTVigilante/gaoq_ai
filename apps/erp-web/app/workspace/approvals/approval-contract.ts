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
