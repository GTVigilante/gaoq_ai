import { OrgDomainError } from './org.errors.js';
import {
  assertEntityId,
  assertName,
  assertOptionalId,
  assertOrgCode,
  assertSameTenant,
  assertTenantId,
  toIso,
} from './org.validation.js';

/** 员工在职状态。 */
export type EmployeeStatus = 'probation' | 'active' | 'suspended' | 'terminated';

/**
 * 员工状态机：仅允许表中列出的迁移路径；
 * terminated 为终态，离职不可逆。
 */
export const EMPLOYEE_STATUS_TRANSITIONS: Readonly<Record<EmployeeStatus, readonly EmployeeStatus[]>> = {
  probation: ['active', 'terminated'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  terminated: [],
};

/** 员工聚合根（纯值对象）。领域层不含手机号、身份证、薪资等敏感字段。 */
export interface Employee {
  readonly id: string;
  readonly tenantId: string;
  /** 工号，租户内唯一，唯一性由持久层保证。 */
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: EmployeeStatus;
  /** 所属部门集合，至少包含一个部门。 */
  readonly departmentIds: readonly string[];
  /** 主部门，必须属于 departmentIds。 */
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建员工入参。 */
export interface CreateEmployeeInput {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status?: EmployeeStatus;
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds?: readonly string[];
  readonly jobLevelId?: string | null;
}

/**
 * 更新员工补丁；tenantId 必须传入且与现有实体一致。
 * 注意：不包含 status，状态变更必须走 transitionEmployeeStatus 显式迁移。
 */
export interface UpdateEmployeePatch {
  readonly tenantId: string;
  readonly employeeNo?: string;
  readonly displayName?: string;
  readonly status?: EmployeeStatus;
  readonly departmentIds?: readonly string[];
  readonly primaryDepartmentId?: string;
  readonly positionIds?: readonly string[];
  readonly jobLevelId?: string | null;
}

/** 断言员工状态合法。 */
function assertEmployeeStatus(status: unknown, field = 'status'): asserts status is EmployeeStatus {
  if (
    status !== 'probation' &&
    status !== 'active' &&
    status !== 'suspended' &&
    status !== 'terminated'
  ) {
    throw new OrgDomainError('INVALID_STATUS', `${field} 非法`);
  }
}

/** 断言标识数组元素均非空并去重。 */
function normalizeIdArray(ids: unknown, field: string): string[] {
  if (!Array.isArray(ids)) {
    throw new OrgDomainError('INVALID_ID', `${field} 必须为数组`);
  }
  const normalized: string[] = [];
  for (const id of ids) {
    assertEntityId(id, `${field}[]`);
    normalized.push(id);
  }
  return [...new Set(normalized)];
}

/** 断言部门集合非空且主部门属于该集合。 */
function assertDepartmentMembership(
  departmentIds: readonly string[],
  primaryDepartmentId: string,
): void {
  if (departmentIds.length === 0) {
    throw new OrgDomainError('EMPTY_DEPARTMENT_IDS', 'departmentIds 至少包含一个部门');
  }
  assertEntityId(primaryDepartmentId, 'primaryDepartmentId');
  if (!departmentIds.includes(primaryDepartmentId)) {
    throw new OrgDomainError(
      'PRIMARY_DEPARTMENT_NOT_MEMBER',
      'primaryDepartmentId 必须属于 departmentIds',
    );
  }
}

/**
 * 创建员工。
 * 校验：租户/标识非空、工号白名单、姓名长度、状态枚举、
 * 部门集合非空、主部门必须属于部门集合。
 */
export function createEmployee(input: CreateEmployeeInput, now: Date): Employee {
  assertTenantId(input.tenantId);
  assertEntityId(input.id, 'id');
  assertOrgCode(input.employeeNo, 'employeeNo');
  assertName(input.displayName, 'displayName');
  const status = input.status ?? 'probation';
  assertEmployeeStatus(status);
  const departmentIds = normalizeIdArray(input.departmentIds, 'departmentIds');
  assertDepartmentMembership(departmentIds, input.primaryDepartmentId);
  const positionIds = normalizeIdArray(input.positionIds ?? [], 'positionIds');
  const jobLevelId = input.jobLevelId ?? null;
  assertOptionalId(jobLevelId, 'jobLevelId');

  const occurredAt = toIso(now);
  return {
    id: input.id,
    tenantId: input.tenantId,
    employeeNo: input.employeeNo,
    displayName: input.displayName,
    status,
    departmentIds,
    primaryDepartmentId: input.primaryDepartmentId,
    positionIds,
    jobLevelId,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/**
 * 更新员工基础信息（不可变更新，版本递增）。
 * 禁止通过本函数修改状态：patch.status 一旦传入即抛错，
 * 状态变更必须使用 transitionEmployeeStatus。
 */
export function updateEmployee(
  employee: Employee,
  patch: UpdateEmployeePatch,
  now: Date,
): Employee {
  assertSameTenant(employee.tenantId, patch.tenantId);
  if (patch.status !== undefined && patch.status !== employee.status) {
    throw new OrgDomainError(
      'IMMUTABLE_FIELD',
      '员工状态必须通过 transitionEmployeeStatus 显式迁移',
    );
  }

  const employeeNo = patch.employeeNo ?? employee.employeeNo;
  assertOrgCode(employeeNo, 'employeeNo');
  const displayName = patch.displayName ?? employee.displayName;
  assertName(displayName, 'displayName');
  const departmentIds =
    patch.departmentIds === undefined
      ? [...employee.departmentIds]
      : normalizeIdArray(patch.departmentIds, 'departmentIds');
  const primaryDepartmentId = patch.primaryDepartmentId ?? employee.primaryDepartmentId;
  assertDepartmentMembership(departmentIds, primaryDepartmentId);
  const positionIds =
    patch.positionIds === undefined
      ? [...employee.positionIds]
      : normalizeIdArray(patch.positionIds, 'positionIds');
  const jobLevelId = patch.jobLevelId === undefined ? employee.jobLevelId : patch.jobLevelId;
  assertOptionalId(jobLevelId, 'jobLevelId');

  return {
    ...employee,
    employeeNo,
    displayName,
    departmentIds,
    primaryDepartmentId,
    positionIds,
    jobLevelId,
    version: employee.version + 1,
    updatedAt: toIso(now),
  };
}

/**
 * 员工状态显式迁移（不可变更新，版本递增）。
 * 仅允许 EMPLOYEE_STATUS_TRANSITIONS 中声明的路径；
 * terminated 为终态，任何从 terminated 出发的迁移都会被拒绝（离职不可逆）。
 */
export function transitionEmployeeStatus(
  employee: Employee,
  nextStatus: EmployeeStatus,
  now: Date,
): Employee {
  assertEmployeeStatus(nextStatus, 'nextStatus');
  if (employee.status === 'terminated') {
    throw new OrgDomainError('TERMINATED_IRREVERSIBLE', '离职状态不可逆');
  }
  const allowed = EMPLOYEE_STATUS_TRANSITIONS[employee.status];
  if (!allowed.includes(nextStatus)) {
    throw new OrgDomainError(
      'INVALID_STATUS_TRANSITION',
      `不允许从 ${employee.status} 迁移到 ${nextStatus}`,
    );
  }
  return {
    ...employee,
    status: nextStatus,
    version: employee.version + 1,
    updatedAt: toIso(now),
  };
}
