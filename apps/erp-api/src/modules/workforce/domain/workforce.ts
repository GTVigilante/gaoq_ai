/** 直属汇报关系。 */
export interface ReportingLine {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly managerEmployeeId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** HRBP 主备管辖关系。 */
export interface HrbpAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly departmentId: string;
  readonly primaryEmployeeId: string;
  readonly backupEmployeeIds: readonly string[];
  readonly inheritToDescendants: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 创建直属汇报关系并固化不可变生效区间。 */
export function createReportingLine(input: Omit<ReportingLine, 'version' | 'createdAt' | 'updatedAt'>, now: Date): ReportingLine {
  assertId(input.id, 'id');
  assertId(input.tenantId, 'tenantId');
  assertId(input.employeeId, 'employeeId');
  assertId(input.managerEmployeeId, 'managerEmployeeId');
  if (input.employeeId === input.managerEmployeeId) throw new Error('WORKFORCE_REPORTING_SELF');
  assertRange(input.effectiveFrom, input.effectiveTo);
  const occurredAt = now.toISOString();
  return Object.freeze({ ...input, version: 1, createdAt: occurredAt, updatedAt: occurredAt });
}

/** 创建 HRBP 主备管辖关系。 */
export function createHrbpAssignment(input: Omit<HrbpAssignment, 'version' | 'createdAt' | 'updatedAt'>, now: Date): HrbpAssignment {
  assertId(input.id, 'id');
  assertId(input.tenantId, 'tenantId');
  assertId(input.departmentId, 'departmentId');
  assertId(input.primaryEmployeeId, 'primaryEmployeeId');
  const backupEmployeeIds: unknown = input.backupEmployeeIds;
  if (!isStringArray(backupEmployeeIds) || backupEmployeeIds.length > 3) {
    throw new Error('WORKFORCE_HRBP_BACKUPS_INVALID');
  }
  const backups = backupEmployeeIds.map((id) => id);
  backups.forEach((id) => assertId(id, 'backupEmployeeIds'));
  if (new Set(backups).size !== backups.length || backups.includes(input.primaryEmployeeId)) {
    throw new Error('WORKFORCE_HRBP_BACKUPS_INVALID');
  }
  assertRange(input.effectiveFrom, input.effectiveTo);
  const occurredAt = now.toISOString();
  return Object.freeze({
    ...input,
    backupEmployeeIds: Object.freeze(backups),
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 验证严格本地日期，避免 Date.parse 宽松接受非法日历日期。 */
export function assertLocalDate(value: string, field: string): void {
  if (!DATE.test(value)) throw new Error(`WORKFORCE_${field.toUpperCase()}_INVALID`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) throw new Error(`WORKFORCE_${field.toUpperCase()}_INVALID`);
}

function assertRange(from: string, to: string | null): void {
  assertLocalDate(from, 'effective_from');
  if (to !== null) {
    assertLocalDate(to, 'effective_to');
    if (to < from) throw new Error('WORKFORCE_EFFECTIVE_RANGE_INVALID');
  }
}

function assertId(value: string, field: string): void {
  if (!ID.test(value)) throw new Error(`WORKFORCE_${field.toUpperCase()}_INVALID`);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}
