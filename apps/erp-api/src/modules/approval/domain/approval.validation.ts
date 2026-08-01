import { ApprovalDomainError } from './approval.errors.js';

export const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const APPROVAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const APPROVAL_FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function assertApprovalId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !APPROVAL_ID_PATTERN.test(value)) {
    throw new ApprovalDomainError('APPROVAL_INVALID_ID', `${field} 不符合标识白名单`);
  }
}

export function assertApprovalCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !APPROVAL_CODE_PATTERN.test(value)) {
    throw new ApprovalDomainError('APPROVAL_INVALID_CODE', `${field} 不符合编码白名单`);
  }
}

export function assertFieldKey(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !APPROVAL_FIELD_PATTERN.test(value)) {
    throw new ApprovalDomainError('APPROVAL_INVALID_FIELD_KEY', `${field} 不符合字段键白名单`);
  }
}

export function assertLabel(value: unknown, field: string, maximum = 128): asserts value is string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
    throw new ApprovalDomainError('APPROVAL_INVALID_LABEL', `${field} 长度必须为 1..${maximum}`);
  }
}

export function assertPositiveVersion(value: unknown, field = 'version'): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ApprovalDomainError('APPROVAL_INVALID_VERSION', `${field} 必须为正安全整数`);
  }
}

export function assertSameTenant(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new ApprovalDomainError('APPROVAL_TENANT_MISMATCH', '审批实体租户不匹配');
  }
}

export function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new ApprovalDomainError('APPROVAL_DUPLICATE_VALUE', `${field} 不允许重复`);
  }
}

export function toApprovalIso(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new ApprovalDomainError('APPROVAL_INVALID_DATE', '时间无效');
  }
  return date.toISOString();
}
