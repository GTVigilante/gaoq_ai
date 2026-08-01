import { RecruitmentDomainError } from './recruitment.errors.js';

export const RECRUITMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const RECRUITMENT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertRecruitmentId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !RECRUITMENT_ID_PATTERN.test(value)) {
    throw new RecruitmentDomainError('RECRUITMENT_INVALID_ID', `${field} 不符合标识白名单`);
  }
}

export function assertRecruitmentCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !RECRUITMENT_CODE_PATTERN.test(value)) {
    throw new RecruitmentDomainError('RECRUITMENT_INVALID_CODE', `${field} 不符合编码白名单`);
  }
}

export function assertRecruitmentLabel(
  value: unknown,
  field: string,
  maximum = 128,
  minimum = 1,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.length > maximum
  ) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_INVALID_LABEL', `${field} 长度必须为 ${minimum}..${maximum}`,
    );
  }
}

export function assertRecruitmentVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RecruitmentDomainError('RECRUITMENT_INVALID_VERSION', 'version 必须为正安全整数');
  }
}

export function assertRecruitmentTenant(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new RecruitmentDomainError('RECRUITMENT_TENANT_MISMATCH', '招聘实体租户不匹配');
  }
}

export function toRecruitmentIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RecruitmentDomainError('RECRUITMENT_INVALID_DATE', '时间无效');
  }
  return value.toISOString();
}

export function deepFreezeRecruitment<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeRecruitment(nested);
  }
  return value;
}
