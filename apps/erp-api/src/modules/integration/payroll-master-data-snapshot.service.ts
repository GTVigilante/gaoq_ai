import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type {
  DepartmentProjection,
  EmployeeProjection,
  EmploymentProjection,
  PayrollMasterDataSnapshotPage,
} from '@gaoq/platform-contracts';
import { createHash } from 'node:crypto';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import {
  DepartmentRepository,
  EmployeeRepository,
  EmploymentRepository,
} from '../org/persistence/org.repositories.js';

const PAGE_SIZE = 200;
const CONTRACT_VERSION = '1.0.0' as const;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CURSOR_FIELDS = ['digest', 'offset'] as const;

interface SnapshotEntry {
  readonly kind: 'department' | 'employee' | 'employment';
  readonly value: DepartmentProjection | EmployeeProjection | EmploymentProjection;
}

/** 向独立专业算薪系统提供可恢复、脱敏、租户隔离的组织主数据快照。 */
@Injectable()
export class PayrollMasterDataSnapshotService {
  constructor(
    private readonly context: TenantContextService,
    private readonly departments: DepartmentRepository,
    private readonly employees: EmployeeRepository,
    private readonly employments: EmploymentRepository,
    private readonly audit: AuditService,
  ) {}

  async page(cursor?: string): Promise<PayrollMasterDataSnapshotPage> {
    const trusted = this.context.getRequired();
    if (
      trusted.actor.actorType !== 'service' &&
      trusted.actor.actorType !== 'system_job'
    ) {
      throw new ForbiddenException({
        code: 'PAYROLL_MASTER_DATA_SERVICE_REQUIRED',
        message: '算薪主数据快照只允许受信服务身份',
      });
    }
    const [departments, employees, employments] = await Promise.all([
      this.departments.findAll(),
      this.employees.findAll(),
      this.employments.findAll(),
    ]);
    const entries: SnapshotEntry[] = [
      ...departments.map((department) => ({
        kind: 'department' as const,
        value: {
          departmentId: department.id,
          code: department.code,
          name: department.name,
          status: department.status,
          parentId: department.parentId,
          managerEmployeeId: department.managerId,
          sortOrder: department.sortOrder,
          aggregateVersion: department.version,
        },
      })),
      ...employees.map((employee) => ({
        kind: 'employee' as const,
        value: {
          employeeId: employee.id,
          employeeNo: employee.employeeNo,
          displayName: employee.displayName,
          status: employee.status,
          departmentIds: [...employee.departmentIds],
          primaryDepartmentId: employee.primaryDepartmentId,
          positionIds: [...employee.positionIds],
          jobLevelId: employee.jobLevelId,
          aggregateVersion: employee.version,
        },
      })),
      ...employments.map((employment) => ({
        kind: 'employment' as const,
        value: {
          employmentId: employment.id,
          personId: employment.personId,
          employeeId: employment.employeeId,
          status: employment.status,
          effectiveFrom: employment.effectiveFrom,
          effectiveTo: employment.effectiveTo,
          aggregateVersion: employment.version,
        },
      })),
    ];
    const snapshotDigest = createHash('sha256')
      .update(JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        tenantId: trusted.tenant.tenantId,
        entries,
      }))
      .digest('hex');
    const offset = parseCursor(cursor, snapshotDigest, entries.length);
    const selected = entries.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + selected.length;
    const page = Object.freeze({
      contractVersion: CONTRACT_VERSION,
      snapshotId: snapshotDigest,
      generatedAt: new Date().toISOString(),
      nextCursor: nextOffset < entries.length
        ? Buffer.from(JSON.stringify({ digest: snapshotDigest, offset: nextOffset }))
          .toString('base64url')
        : null,
      departments: Object.freeze(selected
        .filter((entry) => entry.kind === 'department')
        .map((entry) => entry.value as DepartmentProjection)),
      employees: Object.freeze(selected
        .filter((entry) => entry.kind === 'employee')
        .map((entry) => entry.value as EmployeeProjection)),
      employments: Object.freeze(selected
        .filter((entry) => entry.kind === 'employment')
        .map((entry) => entry.value as EmploymentProjection)),
      snapshotDigest,
    });
    await this.audit.record({
      action: 'integration.payroll_master_data.snapshot.read',
      resourceType: 'payroll_master_data_snapshot',
      resourceId: snapshotDigest,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        offset,
        departmentCount: page.departments.length,
        employeeCount: page.employees.length,
        employmentCount: page.employments.length,
        hasNextPage: page.nextCursor !== null,
      },
    });
    return page;
  }
}

const parseCursor = (
  cursor: string | undefined,
  expectedDigest: string,
  total: number,
): number => {
  if (cursor === undefined) return 0;
  try {
    if (!CURSOR_PATTERN.test(cursor)) throw new Error('invalid');
    const cursorBytes = Buffer.from(cursor, 'base64url');
    if (cursorBytes.toString('base64url') !== cursor) throw new Error('invalid');
    const decoded = JSON.parse(cursorBytes.toString('utf8')) as unknown;
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded)
    ) throw new Error('invalid');
    const record = decoded as Record<string, unknown>;
    const fields = Object.keys(record).sort();
    if (
      fields.length !== CURSOR_FIELDS.length ||
      fields.some((field, index) => field !== CURSOR_FIELDS[index]) ||
      typeof record.digest !== 'string' ||
      !SHA256_PATTERN.test(record.digest) ||
      record.digest !== expectedDigest ||
      !Number.isInteger(record.offset) ||
      (record.offset as number) <= 0 ||
      (record.offset as number) >= total ||
      (record.offset as number) % PAGE_SIZE !== 0
    ) throw new Error('invalid');
    return record.offset as number;
  } catch {
    throw new BadRequestException({
      code: 'PAYROLL_MASTER_DATA_CURSOR_INVALID',
      message: '快照游标无效或主数据已变化，请从第一页重新同步',
    });
  }
};
