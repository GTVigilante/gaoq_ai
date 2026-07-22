import { parseApprovalSummaries, type ApprovalSummary } from './approval-contract';

export interface ApprovalDelegationCreateInput {
  readonly delegateId: string;
  readonly validFrom: string;
  readonly validUntil: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 校验转交/加签响应，拒绝租户字段和非运行中实例。 */
export function parseApprovalTaskResponse(value: unknown): ApprovalSummary {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'instance') || !isPlainObject(value.instance)) {
    throw new Error('APPROVAL_TASK_RESPONSE_INVALID');
  }
  if (Object.hasOwn(value.instance, 'tenantId')) throw new Error('APPROVAL_TASK_RESPONSE_INVALID');
  const instance = parseApprovalSummaries([value.instance])[0];
  if (instance === undefined || instance.status !== 'running') throw new Error('APPROVAL_TASK_RESPONSE_INVALID');
  return instance;
}

/** 规范本人限期委托入参；主体、日期顺序和最长 30 天均失败关闭。 */
export function buildApprovalDelegationCreateInput(
  value: unknown,
  actorId: string,
): ApprovalDelegationCreateInput {
  if (!isPlainObject(value) || !ID_PATTERN.test(actorId)) throw invalidDelegation();
  if (
    typeof value.delegateId !== 'string' || !ID_PATTERN.test(value.delegateId) || value.delegateId === actorId ||
    typeof value.validFrom !== 'string' || typeof value.validUntil !== 'string'
  ) throw invalidDelegation();
  const validFrom = new Date(value.validFrom);
  const validUntil = new Date(value.validUntil);
  if (
    Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()) ||
    validUntil.getTime() <= validFrom.getTime() ||
    validUntil.getTime() - validFrom.getTime() > 30 * 24 * 60 * 60 * 1_000
  ) throw invalidDelegation();
  return Object.freeze({
    delegateId: value.delegateId,
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDelegation(): Error {
  return new Error('APPROVAL_DELEGATION_INPUT_INVALID');
}
