import { OrgDomainError } from './org.errors.js';
import {
  assertEntityId,
  assertName,
  assertOptionalId,
  assertOrgCode,
  assertSameTenant,
  assertSortOrder,
  assertTenantId,
  toIso,
} from './org.validation.js';

/** 部门状态。 */
export type DepartmentStatus = 'active' | 'inactive';

/** 部门聚合根（纯值对象，不依赖任何框架）。 */
export interface Department {
  readonly id: string;
  readonly tenantId: string;
  /** 租户内唯一编码，唯一性由持久层保证。 */
  readonly code: string;
  readonly name: string;
  readonly status: DepartmentStatus;
  /** 上级部门；根部门为 null。 */
  readonly parentId: string | null;
  /** 部门负责人（员工标识）；未任命为 null。 */
  readonly managerId: string | null;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建部门入参。 */
export interface CreateDepartmentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly status?: DepartmentStatus;
  readonly parentId?: string | null;
  readonly managerId?: string | null;
  readonly sortOrder?: number;
}

/** 更新部门补丁；tenantId 必须传入且与现有实体一致，用于跨租户防护。 */
export interface UpdateDepartmentPatch {
  readonly tenantId: string;
  readonly code?: string;
  readonly name?: string;
  readonly status?: DepartmentStatus;
  readonly parentId?: string | null;
  readonly managerId?: string | null;
  readonly sortOrder?: number;
}

/** 断言部门状态合法。 */
function assertDepartmentStatus(status: unknown, field = 'status'): asserts status is DepartmentStatus {
  if (status !== 'active' && status !== 'inactive') {
    throw new OrgDomainError('INVALID_STATUS', `${field} 仅允许 active/inactive`);
  }
}

/** 禁止将部门的上级设置为自身。 */
function assertNotSelfParent(id: string, parentId: string | null): void {
  if (parentId !== null && parentId === id) {
    throw new OrgDomainError('SELF_PARENT', '部门上级不能是自身');
  }
}

/**
 * 创建部门。
 * 校验：租户/标识非空、编码白名单、名称长度、状态枚举、排序非负整数、禁止 self-parent。
 */
export function createDepartment(input: CreateDepartmentInput, now: Date): Department {
  assertTenantId(input.tenantId);
  assertEntityId(input.id, 'id');
  assertOrgCode(input.code, 'code');
  assertName(input.name, 'name');
  const status = input.status ?? 'active';
  assertDepartmentStatus(status);
  const parentId = input.parentId ?? null;
  assertOptionalId(parentId, 'parentId');
  assertNotSelfParent(input.id, parentId);
  const managerId = input.managerId ?? null;
  assertOptionalId(managerId, 'managerId');
  const sortOrder = input.sortOrder ?? 0;
  assertSortOrder(sortOrder);

  const occurredAt = toIso(now);
  return {
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name,
    status,
    parentId,
    managerId,
    sortOrder,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/**
 * 更新部门，返回新对象（不可变更新，版本递增）。
 * 校验：禁止跨租户修改、编码白名单、名称长度、状态枚举、禁止 self-parent；
 * id/tenantId/createdAt 不可变。
 */
export function updateDepartment(
  department: Department,
  patch: UpdateDepartmentPatch,
  now: Date,
): Department {
  assertSameTenant(department.tenantId, patch.tenantId);

  const code = patch.code ?? department.code;
  assertOrgCode(code, 'code');
  const name = patch.name ?? department.name;
  assertName(name, 'name');
  const status = patch.status ?? department.status;
  assertDepartmentStatus(status);
  const parentId = patch.parentId === undefined ? department.parentId : patch.parentId;
  assertOptionalId(parentId, 'parentId');
  assertNotSelfParent(department.id, parentId);
  const managerId = patch.managerId === undefined ? department.managerId : patch.managerId;
  assertOptionalId(managerId, 'managerId');
  const sortOrder = patch.sortOrder ?? department.sortOrder;
  assertSortOrder(sortOrder);

  return {
    ...department,
    code,
    name,
    status,
    parentId,
    managerId,
    sortOrder,
    version: department.version + 1,
    updatedAt: toIso(now),
  };
}
