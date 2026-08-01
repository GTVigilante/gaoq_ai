import { OrgDomainError } from './org.errors.js';

/**
 * 组织域编码白名单：字母数字开头，仅允许字母、数字、连字符、下划线，最长 32 位。
 * 编码在租户内具有唯一语义，唯一性由持久层保证，领域层只校验格式。
 */
export const ORG_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 名称长度下限（去除首尾空白后）。 */
export const NAME_MIN_LENGTH = 1;
/** 名称长度上限。 */
export const NAME_MAX_LENGTH = 64;

/** 断言租户标识非空；租户上下文必须来自已验证身份，禁止空值进入领域对象。 */
export function assertTenantId(tenantId: unknown, field = 'tenantId'): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new OrgDomainError('INVALID_TENANT', `${field} 不能为空`);
  }
}

/** 断言实体标识非空。 */
export function assertEntityId(id: unknown, field: string): asserts id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new OrgDomainError('INVALID_ID', `${field} 不能为空`);
  }
}

/** 断言编码命中白名单。 */
export function assertOrgCode(code: unknown, field: string): asserts code is string {
  if (typeof code !== 'string' || !ORG_CODE_PATTERN.test(code)) {
    throw new OrgDomainError(
      'INVALID_CODE',
      `${field} 仅允许字母数字开头，含字母/数字/连字符/下划线，最长 32 位`,
    );
  }
}

/** 断言名称去除空白后长度在允许区间内。 */
export function assertName(name: unknown, field: string): asserts name is string {
  if (typeof name !== 'string') {
    throw new OrgDomainError('INVALID_NAME', `${field} 必须为字符串`);
  }
  const length = name.trim().length;
  if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH) {
    throw new OrgDomainError(
      'INVALID_NAME',
      `${field} 长度须在 ${NAME_MIN_LENGTH}~${NAME_MAX_LENGTH} 之间`,
    );
  }
}

/** 断言可选标识（允许 null/undefined，非空时必须为合法字符串）。 */
export function assertOptionalId(id: unknown, field: string): asserts id is string | null | undefined {
  if (id === null || id === undefined) {
    return;
  }
  assertEntityId(id, field);
}

/** 断言排序值为非负整数。 */
export function assertSortOrder(sortOrder: unknown, field = 'sortOrder'): asserts sortOrder is number {
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new OrgDomainError('INVALID_SORT_ORDER', `${field} 必须为非负整数`);
  }
}

/** 断言更新补丁的租户标识与现有实体一致，防止跨租户篡改。 */
export function assertSameTenant(currentTenantId: string, patchTenantId: unknown): void {
  assertTenantId(patchTenantId);
  if (patchTenantId !== currentTenantId) {
    throw new OrgDomainError('CROSS_TENANT', '禁止跨租户修改组织对象');
  }
}

/** 将时间统一转换为 ISO 字符串。 */
export function toIso(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new OrgDomainError('INVALID_TIME', 'now 必须为合法 Date');
  }
  return now.toISOString();
}
