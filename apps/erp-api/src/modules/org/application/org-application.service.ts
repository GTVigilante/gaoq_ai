import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  buildDepartmentCreatedEvent,
  buildDepartmentUpdatedEvent,
  buildEmployeeCreatedEvent,
  buildEmployeeStatusChangedEvent,
  buildEmployeeUpdatedEvent,
  buildJobLevelCreatedEvent,
  buildJobLevelUpdatedEvent,
  buildPositionCreatedEvent,
  buildPositionUpdatedEvent,
  createDepartment,
  createEmployee,
  createJobLevel,
  createPosition,
  OrgDomainError,
  transitionEmployeeStatus,
  updateDepartment,
  updateEmployee,
  updateJobLevel,
  updatePosition,
  type Department,
  type Employee,
  type JobLevel,
  type Position,
} from '../domain/index.js';
import {
  DepartmentRepository,
  EmployeeRepository,
  JobLevelRepository,
  OrgWriteConflictError,
  PositionRepository,
} from '../persistence/org.repositories.js';
import { OrgOutboxWriter } from '../persistence/outbox.writer.js';
import type {
  CreateDepartmentDto,
  CreateEmployeeDto,
  CreateJobLevelDto,
  CreatePositionDto,
  TransitionEmployeeStatusDto,
  UpdateDepartmentDto,
  UpdateEmployeeDto,
  UpdateJobLevelDto,
  UpdatePositionDto,
} from './org.dto.js';

const MAX_DEPARTMENT_DEPTH = 100;

export interface OrgChart {
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
}

/** 组织主数据应用服务：统一事务、引用校验、并发控制、Outbox 与数据权限。 */
@Injectable()
export class OrgApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly departments: DepartmentRepository,
    private readonly employees: EmployeeRepository,
    private readonly positions: PositionRepository,
    private readonly jobLevels: JobLevelRepository,
    private readonly outbox: OrgOutboxWriter,
  ) {}

  /** 返回按已验证令牌部门范围裁剪的组织视图。 */
  async getOrgChart(): Promise<OrgChart> {
    const actor = this.context.getActorRequired();
    const [departments, employees] = await Promise.all([
      this.departments.findAll(),
      this.employees.findAll(),
    ]);
    if (actor.scopes.includes('erp:org:chart:read_all')) {
      return { departments, employees };
    }
    const visible = new Set(actor.departmentIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const department of departments) {
        if (department.parentId !== null && visible.has(department.parentId) && !visible.has(department.id)) {
          visible.add(department.id);
          changed = true;
        }
      }
    }
    return {
      departments: departments.filter((department) => visible.has(department.id)),
      employees: employees.filter((employee) =>
        employee.departmentIds.some((departmentId) => visible.has(departmentId)),
      ),
    };
  }

  async createDepartment(
    key: string,
    input: CreateDepartmentDto,
  ): Promise<{ readonly department: Department }> {
    return this.run(async () => this.idempotency.execute(
      'org.department.create',
      key,
      input,
      async (session) => {
        const now = new Date();
        const department = createDepartment({
          ...input,
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.assertDepartmentReferences(department, session);
        await this.departments.insert(department, session);
        await this.outbox.append(buildDepartmentCreatedEvent(department, now), session);
        return { department };
      },
    ));
  }

  async updateDepartment(
    id: string,
    expectedVersion: number,
    key: string,
    patch: UpdateDepartmentDto,
  ): Promise<{ readonly department: Department }> {
    this.assertNonEmptyPatch(patch);
    return this.run(async () => this.idempotency.execute(
      'org.department.update',
      key,
      { id, expectedVersion, patch },
      async (session) => {
        const current = await this.requireDepartment(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const now = new Date();
        const department = updateDepartment(current, {
          ...patch,
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.assertDepartmentReferences(department, session);
        await this.departments.replace(department, expectedVersion, session);
        await this.outbox.append(buildDepartmentUpdatedEvent(department, now), session);
        return { department };
      },
    ));
  }

  async createPosition(
    key: string,
    input: CreatePositionDto,
  ): Promise<{ readonly position: Position }> {
    return this.run(async () => this.idempotency.execute(
      'org.position.create',
      key,
      input,
      async (session) => {
        const now = new Date();
        const position = createPosition({
          ...input,
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.positions.insert(position, session);
        await this.outbox.append(buildPositionCreatedEvent(position, now), session);
        return { position };
      },
    ));
  }

  async updatePosition(
    id: string,
    expectedVersion: number,
    key: string,
    patch: UpdatePositionDto,
  ): Promise<{ readonly position: Position }> {
    this.assertNonEmptyPatch(patch);
    return this.run(async () => this.idempotency.execute(
      'org.position.update',
      key,
      { id, expectedVersion, patch },
      async (session) => {
        const current = await this.requirePosition(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const now = new Date();
        const position = updatePosition(current, {
          ...patch,
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.positions.replace(position, expectedVersion, session);
        await this.outbox.append(buildPositionUpdatedEvent(position, now), session);
        return { position };
      },
    ));
  }

  async createJobLevel(
    key: string,
    input: CreateJobLevelDto,
  ): Promise<{ readonly jobLevel: JobLevel }> {
    return this.run(async () => this.idempotency.execute(
      'org.job_level.create',
      key,
      input,
      async (session) => {
        const now = new Date();
        const jobLevel = createJobLevel({
          ...input,
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.jobLevels.insert(jobLevel, session);
        await this.outbox.append(buildJobLevelCreatedEvent(jobLevel, now), session);
        return { jobLevel };
      },
    ));
  }

  async updateJobLevel(
    id: string,
    expectedVersion: number,
    key: string,
    patch: UpdateJobLevelDto,
  ): Promise<{ readonly jobLevel: JobLevel }> {
    this.assertNonEmptyPatch(patch);
    return this.run(async () => this.idempotency.execute(
      'org.job_level.update',
      key,
      { id, expectedVersion, patch },
      async (session) => {
        const current = await this.requireJobLevel(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const now = new Date();
        const jobLevel = updateJobLevel(current, {
          ...patch,
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.jobLevels.replace(jobLevel, expectedVersion, session);
        await this.outbox.append(buildJobLevelUpdatedEvent(jobLevel, now), session);
        return { jobLevel };
      },
    ));
  }

  async createEmployee(
    key: string,
    input: CreateEmployeeDto,
  ): Promise<{ readonly employee: Employee }> {
    return this.run(async () => this.idempotency.execute(
      'org.employee.create',
      key,
      input,
      async (session) => {
        const now = new Date();
        const employee = createEmployee({
          ...input,
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.assertEmployeeReferences(employee, session);
        await this.employees.insert(employee, session);
        await this.outbox.append(buildEmployeeCreatedEvent(employee, now), session);
        return { employee };
      },
    ));
  }

  async updateEmployee(
    id: string,
    expectedVersion: number,
    key: string,
    patch: UpdateEmployeeDto,
  ): Promise<{ readonly employee: Employee }> {
    this.assertNonEmptyPatch(patch);
    return this.run(async () => this.idempotency.execute(
      'org.employee.update',
      key,
      { id, expectedVersion, patch },
      async (session) => {
        const current = await this.requireEmployee(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const now = new Date();
        const employee = updateEmployee(current, {
          ...patch,
          tenantId: this.context.getTenantRequired().tenantId,
        }, now);
        await this.assertEmployeeReferences(employee, session);
        await this.employees.replace(employee, expectedVersion, session);
        await this.outbox.append(buildEmployeeUpdatedEvent(employee, now), session);
        return { employee };
      },
    ));
  }

  async transitionEmployeeStatus(
    id: string,
    expectedVersion: number,
    key: string,
    input: TransitionEmployeeStatusDto,
  ): Promise<{ readonly employee: Employee }> {
    return this.run(async () => this.idempotency.execute(
      'org.employee.status_transition',
      key,
      { id, expectedVersion, input },
      async (session) => {
        const current = await this.requireEmployee(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const now = new Date();
        const employee = transitionEmployeeStatus(current, input.status, now);
        await this.employees.replace(employee, expectedVersion, session);
        await this.outbox.append(
          buildEmployeeStatusChangedEvent(employee, current.status, now),
          session,
        );
        return { employee };
      },
    ));
  }

  private async assertDepartmentReferences(
    department: Department,
    session: ClientSession,
  ): Promise<void> {
    if (department.managerId !== null) {
      const manager = await this.employees.findById(department.managerId, session);
      if (manager === null || manager.status === 'terminated') {
        throw new BadRequestException({ code: 'ORG_INVALID_MANAGER', message: '部门负责人不存在或已离职' });
      }
    }
    let parentId = department.parentId;
    for (let depth = 0; parentId !== null; depth += 1) {
      if (depth >= MAX_DEPARTMENT_DEPTH) {
        throw new BadRequestException({ code: 'ORG_HIERARCHY_TOO_DEEP', message: '部门层级超过限制' });
      }
      if (parentId === department.id) {
        throw new BadRequestException({ code: 'ORG_DEPARTMENT_CYCLE', message: '部门层级不能形成环' });
      }
      const parent = await this.departments.findById(parentId, session);
      if (parent === null || parent.status !== 'active') {
        throw new BadRequestException({ code: 'ORG_INVALID_PARENT', message: '上级部门不存在或未启用' });
      }
      parentId = parent.parentId;
    }
  }

  private async assertEmployeeReferences(employee: Employee, session: ClientSession): Promise<void> {
    const departments = await this.departments.findByIds(employee.departmentIds, session);
    if (departments.length !== employee.departmentIds.length || departments.some((item) => item.status !== 'active')) {
      throw new BadRequestException({ code: 'ORG_INVALID_DEPARTMENT_REFERENCE', message: '员工所属部门不存在或未启用' });
    }
    const positions = await this.positions.findByIds(employee.positionIds, session);
    if (positions.length !== employee.positionIds.length || positions.some((item) => item.status !== 'active')) {
      throw new BadRequestException({ code: 'ORG_INVALID_POSITION_REFERENCE', message: '员工岗位不存在或未启用' });
    }
    if (employee.jobLevelId !== null && await this.jobLevels.findById(employee.jobLevelId, session) === null) {
      throw new BadRequestException({ code: 'ORG_INVALID_JOB_LEVEL_REFERENCE', message: '员工职级不存在' });
    }
  }

  private async requireDepartment(id: string, session: ClientSession): Promise<Department> {
    const value = await this.departments.findById(id, session);
    if (value === null) throw this.notFound('department', id);
    return value;
  }

  private async requireEmployee(id: string, session: ClientSession): Promise<Employee> {
    const value = await this.employees.findById(id, session);
    if (value === null) throw this.notFound('employee', id);
    return value;
  }

  private async requirePosition(id: string, session: ClientSession): Promise<Position> {
    const value = await this.positions.findById(id, session);
    if (value === null) throw this.notFound('position', id);
    return value;
  }

  private async requireJobLevel(id: string, session: ClientSession): Promise<JobLevel> {
    const value = await this.jobLevels.findById(id, session);
    if (value === null) throw this.notFound('job_level', id);
    return value;
  }

  private notFound(type: string, id: string): NotFoundException {
    return new NotFoundException({ code: 'ORG_NOT_FOUND', message: `${type} ${id} 不存在` });
  }

  private assertExpectedVersion(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new ConflictException({ code: 'ORG_VERSION_CONFLICT', message: '组织主数据版本冲突' });
    }
  }

  private assertNonEmptyPatch(patch: object): void {
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({ code: 'ORG_EMPTY_PATCH', message: '更新内容不能为空' });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OrgDomainError) {
        throw new BadRequestException({ code: `ORG_${error.code}`, message: error.message });
      }
      if (error instanceof OrgWriteConflictError) {
        throw new ConflictException({ code: 'ORG_VERSION_CONFLICT', message: error.message });
      }
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException({ code: 'ORG_UNIQUE_CONFLICT', message: '组织编码或工号已存在' });
      }
      throw error;
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
  }
}
