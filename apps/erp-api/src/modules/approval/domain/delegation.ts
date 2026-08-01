import { ApprovalDomainError } from './approval.errors.js';
import { assertApprovalId, assertPositiveVersion, assertSameTenant, toApprovalIso } from './approval.validation.js';

const MAX_DELEGATION_MS = 30 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface ApprovalDelegation {
  readonly id: string;
  readonly tenantId: string;
  readonly principalApproverId: string;
  readonly delegateId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: 'active' | 'revoked';
  readonly version: number;
  readonly createdBy: string;
  readonly revokedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建限期审批委托；只允许本人授权，最长 30 天且不接受明显回填。 */
export function createApprovalDelegation(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly principalApproverId: string;
    readonly delegateId: string;
    readonly validFrom: string;
    readonly validUntil: string;
    readonly actorId: string;
  },
  now: Date,
): ApprovalDelegation {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    principalApproverId: input.principalApproverId,
    delegateId: input.delegateId,
    actorId: input.actorId,
  })) assertApprovalId(value, field);
  if (input.actorId !== input.principalApproverId) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_OWNER_DENIED', '只能为本人创建审批委托');
  }
  if (input.principalApproverId === input.delegateId) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_SELF_DENIED', '审批委托人与代理人不能相同');
  }
  const validFrom = parseDate(input.validFrom);
  const validUntil = parseDate(input.validUntil);
  if (
    validFrom.getTime() < now.getTime() - CLOCK_SKEW_MS ||
    validUntil.getTime() <= validFrom.getTime() ||
    validUntil.getTime() - validFrom.getTime() > MAX_DELEGATION_MS
  ) throw new ApprovalDomainError(
    'APPROVAL_DELEGATION_PERIOD_INVALID',
    '委托必须从当前时间附近或未来开始，截止时间晚于开始时间且最长 30 天',
  );
  const occurredAt = toApprovalIso(now);
  return deepFreeze({
    id: input.id,
    tenantId: input.tenantId,
    principalApproverId: input.principalApproverId,
    delegateId: input.delegateId,
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
    status: 'active',
    version: 1,
    createdBy: input.actorId,
    revokedBy: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 撤销本人委托；已撤销记录和旧版本均失败关闭。 */
export function revokeApprovalDelegation(
  current: ApprovalDelegation,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly actorId: string },
  now: Date,
): ApprovalDelegation {
  assertSameTenant(current.tenantId, input.tenantId);
  assertPositiveVersion(input.expectedVersion);
  assertApprovalId(input.actorId, 'actorId');
  if (current.version !== input.expectedVersion) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_VERSION_CONFLICT', '审批委托版本冲突');
  }
  if (current.principalApproverId !== input.actorId || current.status !== 'active') {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_REVOKE_DENIED', '只能撤销本人当前有效的审批委托');
  }
  const occurredAt = toApprovalIso(now);
  return deepFreeze({
    ...current,
    status: 'revoked',
    version: current.version + 1,
    revokedBy: input.actorId,
    updatedAt: occurredAt,
  });
}

/** 从持久化边界恢复并复核审批委托完整性。 */
export function restoreApprovalDelegation(value: ApprovalDelegation): ApprovalDelegation {
  for (const [field, id] of Object.entries({
    id: value.id,
    tenantId: value.tenantId,
    principalApproverId: value.principalApproverId,
    delegateId: value.delegateId,
    createdBy: value.createdBy,
  })) assertApprovalId(id, field);
  if (value.revokedBy !== null) assertApprovalId(value.revokedBy, 'revokedBy');
  assertPositiveVersion(value.version);
  const from = parseDate(value.validFrom);
  const until = parseDate(value.validUntil);
  parseDate(value.createdAt);
  parseDate(value.updatedAt);
  if (
    value.principalApproverId === value.delegateId || until.getTime() <= from.getTime() ||
    until.getTime() - from.getTime() > MAX_DELEGATION_MS ||
    (value.status === 'active' && value.revokedBy !== null) ||
    (value.status === 'revoked' && value.revokedBy === null)
  ) throw new ApprovalDomainError('APPROVAL_DELEGATION_INTEGRITY_INVALID', '审批委托持久化数据无效');
  return deepFreeze({ ...value });
}

/** 生成委托覆盖的 UTC 日槽；唯一多键索引用于并发重叠的数据库最终兜底。 */
export function approvalDelegationCoverageDays(validFrom: string, validUntil: string): readonly string[] {
  const from = parseDate(validFrom);
  const until = parseDate(validUntil);
  if (until.getTime() <= from.getTime() || until.getTime() - from.getTime() > MAX_DELEGATION_MS) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_PERIOD_INVALID', '审批委托有效期无效');
  }
  const cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const last = new Date(until.getTime() - 1);
  const finalDay = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const days: string[] = [];
  for (let day = cursor; day <= finalDay; day += 24 * 60 * 60 * 1_000) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return Object.freeze(days);
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new ApprovalDomainError('APPROVAL_DELEGATION_DATE_INVALID', '审批委托时间必须为规范 UTC ISO 时间');
  }
  return date;
}

function deepFreeze<T>(value: T): T {
  return Object.freeze(value);
}
