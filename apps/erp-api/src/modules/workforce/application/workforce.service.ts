import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { DepartmentRepository, EmployeeRepository } from '../../org/persistence/org.repositories.js';
import { createHrbpAssignment, createReportingLine, assertLocalDate, type HrbpAssignment, type ReportingLine } from '../domain/workforce.js';
import { HrbpAssignmentRepository, ReportingLineRepository } from '../persistence/workforce.repositories.js';
import type { CreateHrbpAssignmentDto, CreateReportingLineDto } from './workforce.dto.js';

/** 汇报关系与 HRBP 管辖的统一深模块；调用方不负责组织引用、范围或环路校验。 */
@Injectable()
export class WorkforceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly employees: EmployeeRepository,
    private readonly departments: DepartmentRepository,
    private readonly reporting: ReportingLineRepository,
    private readonly hrbp: HrbpAssignmentRepository,
  ) {}

  async assignReportingLine(key: string, input: CreateReportingLineDto): Promise<{ readonly reportingLine: ReportingLine }> {
    this.requireScope('erp:workforce:relationship:write');
    return this.idempotency.execute('workforce.reporting_line.assign', key, input, async (session) => {
      const employee = await this.activeEmployee(input.employeeId, session);
      await this.activeEmployee(input.managerEmployeeId, session);
      this.requireDepartment(employee.primaryDepartmentId);
      if (await this.reporting.overlaps(input.employeeId, input.effectiveFrom, input.effectiveTo ?? null, session)) {
        throw new ConflictException({ code: 'WORKFORCE_REPORTING_OVERLAP', message: '员工在该时段已有直属汇报关系' });
      }
      await this.assertNoReportingCycle(input.employeeId, input.managerEmployeeId, input.effectiveFrom, session);
      const value = createReportingLine({
        id: createEventId(), tenantId: this.context.getTenantRequired().tenantId,
        employeeId: input.employeeId, managerEmployeeId: input.managerEmployeeId,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
      }, new Date());
      await this.reporting.insert(value, session);
      return { reportingLine: value };
    });
  }

  async assignHrbp(key: string, input: CreateHrbpAssignmentDto): Promise<{ readonly assignment: HrbpAssignment }> {
    this.requireScope('erp:workforce:hrbp:write');
    return this.idempotency.execute('workforce.hrbp.assign', key, input, async (session) => {
      const department = await this.departments.findById(input.departmentId, session);
      if (department === null || department.status !== 'active') throw new NotFoundException({ code: 'WORKFORCE_DEPARTMENT_UNAVAILABLE', message: '部门不存在或不可用' });
      this.requireDepartment(department.id);
      await this.activeEmployee(input.primaryEmployeeId, session);
      for (const employeeId of input.backupEmployeeIds) await this.activeEmployee(employeeId, session);
      if (await this.hrbp.overlaps(input.departmentId, input.effectiveFrom, input.effectiveTo ?? null, session)) {
        throw new ConflictException({ code: 'WORKFORCE_HRBP_OVERLAP', message: '部门在该时段已有 HRBP 管辖关系' });
      }
      const value = createHrbpAssignment({
        id: createEventId(), tenantId: this.context.getTenantRequired().tenantId,
        departmentId: input.departmentId, primaryEmployeeId: input.primaryEmployeeId,
        backupEmployeeIds: input.backupEmployeeIds,
        inheritToDescendants: input.inheritToDescendants,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
      }, new Date());
      await this.hrbp.insert(value, session);
      return { assignment: value };
    });
  }

  async listReportingLines(asOf: string): Promise<readonly ReportingLine[]> {
    this.requireScope('erp:workforce:relationship:read');
    assertLocalDate(asOf, 'as_of');
    const actor = this.context.getActorRequired();
    const relations = await this.reporting.list(asOf);
    if (actor.scopes.includes('erp:workforce:relationship:read_all')) return relations;
    const employees = await this.employees.findByIds(relations.map((item) => item.employeeId));
    if (employees.length !== relations.length) {
      throw new Error('WORKFORCE_REPORTING_EMPLOYEE_REFERENCE_INVALID');
    }
    const visibleEmployeeIds = new Set(
      employees
        .filter((employee) => employee.departmentIds.some((departmentId) => actor.departmentIds.includes(departmentId)))
        .map((employee) => employee.id),
    );
    return Object.freeze(relations.filter((item) => visibleEmployeeIds.has(item.employeeId)));
  }

  async listHrbpAssignments(asOf: string): Promise<readonly HrbpAssignment[]> {
    this.requireScope('erp:workforce:hrbp:read');
    assertLocalDate(asOf, 'as_of');
    const actor = this.context.getActorRequired();
    const assignments = await this.hrbp.list(asOf);
    return actor.scopes.includes('erp:workforce:hrbp:read_all')
      ? assignments
      : Object.freeze(assignments.filter((item) => actor.departmentIds.includes(item.departmentId)));
  }

  private async activeEmployee(id: string, session: ClientSession) {
    const employee = await this.employees.findById(id, session);
    if (employee === null || !['active', 'probation'].includes(employee.status)) {
      throw new NotFoundException({ code: 'WORKFORCE_EMPLOYEE_UNAVAILABLE', message: '员工不存在或不在有效劳动状态' });
    }
    return employee;
  }

  private async assertNoReportingCycle(employeeId: string, managerId: string, asOf: string, session: ClientSession): Promise<void> {
    let current = managerId;
    const visited = new Set([employeeId]);
    for (let depth = 0; depth < 100; depth += 1) {
      if (visited.has(current)) throw new ConflictException({ code: 'WORKFORCE_REPORTING_CYCLE', message: '直属汇报关系不能形成环路' });
      visited.add(current);
      const relation = await this.reporting.findEffective(current, asOf, session);
      if (relation === null) return;
      current = relation.managerEmployeeId;
    }
    throw new ConflictException({ code: 'WORKFORCE_REPORTING_DEPTH_LIMIT', message: '直属汇报关系深度超过安全上限' });
  }

  private requireScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({ code: 'WORKFORCE_SCOPE_DENIED', message: '当前身份无权执行该组织协作操作' });
  }

  private requireDepartment(departmentId: string): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:workforce:write_all') && !actor.departmentIds.includes(departmentId)) {
      throw new ForbiddenException({ code: 'WORKFORCE_DEPARTMENT_DENIED', message: '当前身份不具备目标部门数据范围' });
    }
  }
}
