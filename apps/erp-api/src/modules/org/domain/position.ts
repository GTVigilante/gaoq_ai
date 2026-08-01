import { OrgDomainError } from './org.errors.js';
import {
  assertEntityId,
  assertName,
  assertOrgCode,
  assertSameTenant,
  assertTenantId,
  toIso,
} from './org.validation.js';

/** 岗位状态。 */
export type PositionStatus = 'active' | 'inactive';

/** 岗位（纯值对象）；编码在租户内具有唯一语义，唯一性由持久层保证。 */
export interface Position {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly status: PositionStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建岗位入参。 */
export interface CreatePositionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly status?: PositionStatus;
}

/** 更新岗位补丁；tenantId 必须传入且与现有实体一致。 */
export interface UpdatePositionPatch {
  readonly tenantId: string;
  readonly code?: string;
  readonly name?: string;
  readonly status?: PositionStatus;
}

/** 断言岗位状态合法。 */
function assertPositionStatus(status: unknown, field = 'status'): asserts status is PositionStatus {
  if (status !== 'active' && status !== 'inactive') {
    throw new OrgDomainError('INVALID_STATUS', `${field} 仅允许 active/inactive`);
  }
}

/** 创建岗位。校验：租户/标识非空、编码白名单、名称长度、状态枚举。 */
export function createPosition(input: CreatePositionInput, now: Date): Position {
  assertTenantId(input.tenantId);
  assertEntityId(input.id, 'id');
  assertOrgCode(input.code, 'code');
  assertName(input.name, 'name');
  const status = input.status ?? 'active';
  assertPositionStatus(status);

  const occurredAt = toIso(now);
  return {
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name,
    status,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/** 更新岗位（不可变更新，版本递增）；禁止跨租户修改。 */
export function updatePosition(
  position: Position,
  patch: UpdatePositionPatch,
  now: Date,
): Position {
  assertSameTenant(position.tenantId, patch.tenantId);

  const code = patch.code ?? position.code;
  assertOrgCode(code, 'code');
  const name = patch.name ?? position.name;
  assertName(name, 'name');
  const status = patch.status ?? position.status;
  assertPositionStatus(status);

  return {
    ...position,
    code,
    name,
    status,
    version: position.version + 1,
    updatedAt: toIso(now),
  };
}
