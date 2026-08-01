export interface Department {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly sortOrder: number;
  readonly version: number;
}

export interface Employee {
  readonly id: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
  readonly version: number;
}

export interface OrgChart {
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
}

export interface DepartmentCreateInput {
  readonly code: string;
  readonly name: string;
  readonly status: 'active';
  readonly parentId: string | null;
  readonly sortOrder: number;
}

export interface EmployeeCreateInput {
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active';
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
}

export interface DepartmentResult {
  readonly department: Department;
}

export interface EmployeeResult {
  readonly employee: Employee;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEPARTMENT_KEYS = [
  'id', 'code', 'name', 'status', 'parentId', 'managerId', 'sortOrder', 'version',
] as const;
const EMPLOYEE_KEYS = [
  'id', 'employeeNo', 'displayName', 'status', 'departmentIds',
  'primaryDepartmentId', 'positionIds', 'jobLevelId', 'version',
] as const;
const DEPARTMENT_STATUSES = new Set<Department['status']>(['active', 'inactive']);
const EMPLOYEE_STATUSES = new Set<Employee['status']>([
  'probation', 'active', 'suspended', 'terminated',
]);

/** PC 只根据服务端身份摘要中的精确 Scope 决定是否展示组织写入口。 */
export function canWriteOrgMaster(scopes: readonly string[]): boolean {
  return scopes.includes('erp:org:master:write');
}

/** 原请求重试必须仍由创建该请求的同一可信主体执行。 */
export function canExecuteOrgWrite(
  profile: { readonly actorId: string; readonly scopes: readonly string[] } | null,
  attemptedActorId: string,
): boolean {
  return profile !== null &&
    profile.actorId === attemptedActorId &&
    canWriteOrgMaster(profile.scopes);
}

/** 在渲染前严格校验组织公开投影，拒绝租户路由、时间戳和任何未知字段。 */
export function parseOrgChart(value: unknown): OrgChart {
  const record = objectRecord(value, 'ORG_CHART_INVALID');
  if (
    !exactKeys(record, ['departments', 'employees']) ||
    !Array.isArray(record.departments) ||
    !Array.isArray(record.employees) ||
    record.departments.length > 10_000 ||
    record.employees.length > 10_000
  ) throw new Error('ORG_CHART_INVALID');

  const departments = Object.freeze(record.departments.map(parseDepartment));
  const employees = Object.freeze(record.employees.map(parseEmployee));
  if (
    new Set(departments.map((item) => item.id)).size !== departments.length ||
    new Set(employees.map((item) => item.id)).size !== employees.length
  ) throw new Error('ORG_CHART_INVALID');

  return Object.freeze({ departments, employees });
}

/** 校验部门写入结果仍为公开投影。 */
export function parseDepartmentResult(value: unknown): DepartmentResult {
  const record = objectRecord(value, 'ORG_DEPARTMENT_RESULT_INVALID');
  if (!exactKeys(record, ['department'])) throw new Error('ORG_DEPARTMENT_RESULT_INVALID');
  return Object.freeze({ department: parseDepartment(record.department) });
}

/** 校验员工写入结果仍为公开投影。 */
export function parseEmployeeResult(value: unknown): EmployeeResult {
  const record = objectRecord(value, 'ORG_EMPLOYEE_RESULT_INVALID');
  if (!exactKeys(record, ['employee'])) throw new Error('ORG_EMPLOYEE_RESULT_INVALID');
  return Object.freeze({ employee: parseEmployee(record.employee) });
}

/** 将部门表单压缩为服务端允许的最小字段集合。 */
export function buildDepartmentCreateInput(value: unknown): DepartmentCreateInput {
  const record = objectRecord(value, 'ORG_DEPARTMENT_INPUT_INVALID');
  const parentId = record.parentId === undefined || record.parentId === '' ? null : record.parentId;
  const sortOrder = record.sortOrder === undefined ? 0 : record.sortOrder;
  if (
    typeof record.code !== 'string' || !CODE_PATTERN.test(record.code) ||
    typeof record.name !== 'string' || record.name.trim().length < 1 || record.name.length > 128 ||
    !nullableUlid(parentId) ||
    !nonnegativeInteger(sortOrder)
  ) throw new Error('ORG_DEPARTMENT_INPUT_INVALID');
  return Object.freeze({
    code: record.code,
    name: record.name.trim(),
    status: 'active',
    parentId: parentId as string | null,
    sortOrder: sortOrder as number,
  });
}

/** 将员工表单压缩为服务端允许的最小字段集合。 */
export function buildEmployeeCreateInput(value: unknown): EmployeeCreateInput {
  const record = objectRecord(value, 'ORG_EMPLOYEE_INPUT_INVALID');
  if (
    typeof record.employeeNo !== 'string' || !CODE_PATTERN.test(record.employeeNo) ||
    typeof record.displayName !== 'string' ||
    record.displayName.trim().length < 1 ||
    record.displayName.length > 128 ||
    typeof record.primaryDepartmentId !== 'string' ||
    !ULID_PATTERN.test(record.primaryDepartmentId) ||
    (record.status !== 'probation' && record.status !== 'active')
  ) throw new Error('ORG_EMPLOYEE_INPUT_INVALID');
  return Object.freeze({
    employeeNo: record.employeeNo,
    displayName: record.displayName.trim(),
    status: record.status,
    departmentIds: Object.freeze([record.primaryDepartmentId]),
    primaryDepartmentId: record.primaryDepartmentId,
    positionIds: Object.freeze([]),
  });
}

function parseDepartment(value: unknown): Department {
  const record = objectRecord(value, 'ORG_DEPARTMENT_INVALID');
  if (
    !exactKeys(record, DEPARTMENT_KEYS) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.code !== 'string' || !CODE_PATTERN.test(record.code) ||
    typeof record.name !== 'string' || record.name.trim().length < 1 || record.name.length > 128 ||
    typeof record.status !== 'string' ||
    !DEPARTMENT_STATUSES.has(record.status as Department['status']) ||
    !nullableUlid(record.parentId) ||
    !nullableUlid(record.managerId) ||
    !nonnegativeInteger(record.sortOrder) ||
    !positiveInteger(record.version)
  ) throw new Error('ORG_DEPARTMENT_INVALID');
  return Object.freeze({
    id: record.id,
    code: record.code,
    name: record.name,
    status: record.status as Department['status'],
    parentId: record.parentId as string | null,
    managerId: record.managerId as string | null,
    sortOrder: record.sortOrder as number,
    version: record.version as number,
  });
}

function parseEmployee(value: unknown): Employee {
  const record = objectRecord(value, 'ORG_EMPLOYEE_INVALID');
  if (
    !exactKeys(record, EMPLOYEE_KEYS) ||
    typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
    typeof record.employeeNo !== 'string' || !CODE_PATTERN.test(record.employeeNo) ||
    typeof record.displayName !== 'string' ||
    record.displayName.trim().length < 1 ||
    record.displayName.length > 128 ||
    typeof record.status !== 'string' ||
    !EMPLOYEE_STATUSES.has(record.status as Employee['status']) ||
    !uniqueUlids(record.departmentIds, 500, false) ||
    typeof record.primaryDepartmentId !== 'string' ||
    !ULID_PATTERN.test(record.primaryDepartmentId) ||
    !(record.departmentIds as string[]).includes(record.primaryDepartmentId) ||
    !uniqueUlids(record.positionIds, 200, true) ||
    !nullableUlid(record.jobLevelId) ||
    !positiveInteger(record.version)
  ) throw new Error('ORG_EMPLOYEE_INVALID');
  return Object.freeze({
    id: record.id,
    employeeNo: record.employeeNo,
    displayName: record.displayName,
    status: record.status as Employee['status'],
    departmentIds: Object.freeze([...(record.departmentIds as string[])]),
    primaryDepartmentId: record.primaryDepartmentId,
    positionIds: Object.freeze([...(record.positionIds as string[])]),
    jobLevelId: record.jobLevelId as string | null,
    version: record.version as number,
  });
}

function objectRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function nullableUlid(value: unknown): boolean {
  return value === null || (typeof value === 'string' && ULID_PATTERN.test(value));
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function uniqueUlids(value: unknown, maximum: number, allowEmpty: boolean): boolean {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) return false;
  if (value.some((item) => typeof item !== 'string' || !ULID_PATTERN.test(item))) return false;
  return new Set(value).size === value.length;
}
