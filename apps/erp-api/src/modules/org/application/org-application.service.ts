import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { IdentityLifecycleService } from '../../identity/identity-lifecycle.service.js';
import type { EmployeeIdentityTerminationResult } from '../../identity/identity-lifecycle.service.js';
import {
  buildDepartmentCreatedEvent,
  buildDepartmentUpdatedEvent,
  buildEmployeeCreatedEvent,
  buildEmployeeStatusChangedEvent,
  buildEmployeeUpdatedEvent,
  buildEmploymentEstablishedEvent,
  buildEmploymentTerminatedEvent,
  buildEmploymentStatusChangedEvent,
  buildPersonCreatedEvent,
  buildJobLevelCreatedEvent,
  buildJobLevelUpdatedEvent,
  buildPositionCreatedEvent,
  buildPositionUpdatedEvent,
  createDepartment,
  createEmployee,
  createEmployment,
  restoreEmploymentFromMigration,
  createPerson,
  createJobLevel,
  createPosition,
  OrgDomainError,
  transitionEmployeeStatus,
  terminateEmployment,
  transitionEmploymentStatus,
  updateDepartment,
  updateEmployee,
  updateJobLevel,
  updatePosition,
  type Department,
  type Employee,
  type JobLevel,
  type Position,
  type Employment,
} from '../domain/index.js';
import {
  DepartmentRepository,
  EmployeeRepository,
  JobLevelRepository,
  OrgWriteConflictError,
  PositionRepository,
  PersonRepository,
  EmploymentRepository,
  EmployeeNumberSequenceRepository,
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

export interface OrgDepartmentView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: Department['status'];
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly sortOrder: number;
  readonly version: number;
}

export interface OrgEmployeeView {
  readonly id: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: Employee['status'];
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
  readonly version: number;
}

export interface OrgPositionView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: Position['status'];
  readonly version: number;
}

export interface OrgJobLevelView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly track: JobLevel['track'];
  readonly rank: number;
  readonly version: number;
}

export interface OrgChart {
  readonly departments: readonly OrgDepartmentView[];
  readonly employees: readonly OrgEmployeeView[];
}

/** 组织公开投影只保留业务标识和并发版本，禁止暴露租户路由与持久化时间戳。 */
export function toOrgDepartmentView(department: OrgDepartmentView): OrgDepartmentView {
  return Object.freeze({
    id: department.id,
    code: department.code,
    name: department.name,
    status: department.status,
    parentId: department.parentId,
    managerId: department.managerId,
    sortOrder: department.sortOrder,
    version: department.version,
  });
}

/** 员工公开投影不包含租户路由和持久化时间戳。 */
export function toOrgEmployeeView(employee: OrgEmployeeView): OrgEmployeeView {
  return Object.freeze({
    id: employee.id,
    employeeNo: employee.employeeNo,
    displayName: employee.displayName,
    status: employee.status,
    departmentIds: Object.freeze([...employee.departmentIds]),
    primaryDepartmentId: employee.primaryDepartmentId,
    positionIds: Object.freeze([...employee.positionIds]),
    jobLevelId: employee.jobLevelId,
    version: employee.version,
  });
}

/** 岗位公开投影不包含租户路由和持久化时间戳。 */
export function toOrgPositionView(position: OrgPositionView): OrgPositionView {
  return Object.freeze({
    id: position.id,
    code: position.code,
    name: position.name,
    status: position.status,
    version: position.version,
  });
}

/** 职级公开投影不包含租户路由和持久化时间戳。 */
export function toOrgJobLevelView(jobLevel: OrgJobLevelView): OrgJobLevelView {
  return Object.freeze({
    id: jobLevel.id,
    code: jobLevel.code,
    name: jobLevel.name,
    track: jobLevel.track,
    rank: jobLevel.rank,
    version: jobLevel.version,
  });
}

/** 统一生成 REST 与 MCP 共用的组织图最小投影。 */
export function toOrgChartView(chart: OrgChart): OrgChart {
  return Object.freeze({
    departments: Object.freeze(chart.departments.map(toOrgDepartmentView)),
    employees: Object.freeze(chart.employees.map(toOrgEmployeeView)),
  });
}

export interface CareEmploymentSource {
  readonly employee: Employee;
  readonly employment: Employment;
}

export interface ImportEmploymentFromMigrationInput {
  readonly employeeId: string;
  readonly sourcePersonId: string;
  readonly identityEvidenceId: string;
  readonly onboardingInstanceId: string;
  readonly onboardingCompletionEvidenceId: string;
  readonly offerId: string;
  readonly signedEvidenceId: string;
  readonly status: Employment['status'];
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly terminationCareCaseId: string | null;
  readonly terminationExecutionEvidenceId: string | null;
  readonly terminationEvidenceId: string | null;
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
    private readonly persons: PersonRepository,
    private readonly employments: EmploymentRepository,
    private readonly employeeNumbers: EmployeeNumberSequenceRepository,
    private readonly outbox: OrgOutboxWriter,
    private readonly identities: IdentityLifecycleService,
  ) {}

  /** 返回按已验证令牌部门范围裁剪的组织视图。 */
  async getOrgChart(): Promise<OrgChart> {
    const actor = this.context.getActorRequired();
    const [departments, employees] = await Promise.all([
      this.departments.findAll(),
      this.employees.findAll(),
    ]);
    if (actor.scopes.includes('erp:org:chart:read_all')) {
      return toOrgChartView({ departments, employees });
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
    return toOrgChartView({
      departments: departments.filter((department) => visible.has(department.id)),
      employees: employees.filter((employee) =>
        employee.departmentIds.some((departmentId) => visible.has(departmentId)),
      ),
    });
  }

  /** Care 只读取离职编排所需的当前组织与劳动关系，不返回身份或合同原文。 */
  async getEmploymentForCare(employmentId: string): Promise<CareEmploymentSource> {
    this.assertTrustedScope('erp:care:employment:read');
    const employment = await this.employments.findById(employmentId);
    if (employment === null) throw new NotFoundException({
      code: 'ORG_EMPLOYMENT_NOT_FOUND', message: '劳动关系不存在',
    });
    const employee = await this.requireEmployee(employment.employeeId);
    return Object.freeze({ employee, employment });
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

  /**
   * Onboarding 完成闸门专用：在组织域事务内建立 Person、Employee 与 Employment。
   * 调用方只能提交证据引用和组织引用，不能指定 tenantId、工号或聚合标识。
   */
  async establishEmploymentFromOnboarding(
    key: string,
    input: {
      readonly onboardingInstanceId: string;
      readonly onboardingCompletionEvidenceId: string;
      readonly candidateId: string;
      readonly offerId: string;
      readonly signedEvidenceId: string;
      readonly identityEvidenceId: string;
      readonly displayName: string;
      readonly primaryDepartmentId: string;
      readonly orgPositionId: string;
      readonly jobLevelId: string | null;
      readonly effectiveFrom: string;
    },
  ): Promise<{
    readonly employment: Employment;
    readonly employeeId: string;
    readonly employeeNo: string;
    readonly personId: string;
  }> {
    this.assertTrustedScope('erp:onboarding:employment:establish');
    return this.run(async () => this.idempotency.execute(
      'org.employment.establish_from_onboarding', key, input, async (session) => {
        const existing = await this.employments.findByOnboardingInstanceId(
          input.onboardingInstanceId,
          session,
        );
        if (existing !== null) {
          if (
            existing.offerId !== input.offerId ||
            existing.signedEvidenceId !== input.signedEvidenceId ||
            existing.onboardingCompletionEvidenceId !== input.onboardingCompletionEvidenceId ||
            existing.effectiveFrom !== input.effectiveFrom
          ) {
            throw new ConflictException({
              code: 'ORG_ONBOARDING_EMPLOYMENT_MISMATCH',
              message: '该入职实例已绑定不同的完成证据或生效日期',
            });
          }
          const existingPerson = await this.persons.findBySourceCandidateId(
            input.candidateId,
            session,
          );
          if (
            existingPerson === null || existingPerson.id !== existing.personId ||
            existingPerson.identityEvidenceId !== input.identityEvidenceId
          ) throw new ConflictException({
            code: 'ORG_ONBOARDING_PERSON_MISMATCH',
            message: '该入职实例已绑定不同的自然人或身份核验证据',
          });
          const employee = await this.requireEmployee(existing.employeeId, session);
          return {
            employment: existing, employeeId: employee.id,
            employeeNo: employee.employeeNo, personId: existing.personId,
          };
        }

        const now = new Date();
        const tenantId = this.context.getTenantRequired().tenantId;
        let person = await this.persons.findBySourceCandidateId(input.candidateId, session);
        let personCreated = false;
        if (person === null) {
          person = createPerson({
            id: createEventId(now), tenantId, sourceCandidateId: input.candidateId,
            identityEvidenceId: input.identityEvidenceId,
          }, now);
          personCreated = true;
        } else if (person.identityEvidenceId !== input.identityEvidenceId) {
          throw new ConflictException({
            code: 'ORG_PERSON_IDENTITY_EVIDENCE_MISMATCH',
            message: '候选人已绑定不同身份核验证据，必须人工复核',
          });
        }

        const sequence = await this.employeeNumbers.next(now.getUTCFullYear(), session);
        if (sequence > 999_999) throw new ConflictException({
          code: 'ORG_EMPLOYEE_NUMBER_EXHAUSTED', message: '当前年度工号序列已耗尽',
        });
        const employeeNo = `E${now.getUTCFullYear()}${String(sequence).padStart(6, '0')}`;
        const employee = createEmployee({
          id: createEventId(now), tenantId, employeeNo, displayName: input.displayName,
          status: 'probation', departmentIds: [input.primaryDepartmentId],
          primaryDepartmentId: input.primaryDepartmentId, positionIds: [input.orgPositionId],
          jobLevelId: input.jobLevelId,
        }, now);
        await this.assertEmployeeReferences(employee, session);
        const employment = createEmployment({
          id: createEventId(now), tenantId, personId: person.id, employeeId: employee.id,
          onboardingInstanceId: input.onboardingInstanceId, offerId: input.offerId,
          onboardingCompletionEvidenceId: input.onboardingCompletionEvidenceId,
          signedEvidenceId: input.signedEvidenceId, effectiveFrom: input.effectiveFrom,
        }, now);

        if (personCreated) {
          await this.persons.insert(person, session);
          await this.outbox.append(buildPersonCreatedEvent(person, now), session);
        }
        await this.employees.insert(employee, session);
        await this.employments.insert(employment, session);
        await this.outbox.append(buildEmployeeCreatedEvent(employee, now), session);
        await this.outbox.append(buildEmploymentEstablishedEvent(employment, now), session);
        return {
          employment, employeeId: employee.id, employeeNo: employee.employeeNo,
          personId: person.id,
        };
      },
    ));
  }

  /** 数据迁移专用：为既有员工恢复证据完备、状态一致的劳动关系。 */
  async importEmploymentFromMigration(
    key: string,
    input: ImportEmploymentFromMigrationInput,
  ): Promise<{ readonly employment: Employment; readonly personId: string }> {
    this.assertTrustedScope('erp:migration:execute');
    this.assertTrustedScope('erp:org:master:write');
    return this.run(async () => this.idempotency.execute(
      'org.employment.import_from_migration', key, input, async (session) => {
        const employee = await this.requireEmployee(input.employeeId, session);
        const expectedEmployeeStatus = input.status === 'resigned' ? 'terminated' : input.status;
        if (employee.status !== expectedEmployeeStatus) throw new ConflictException({
          code: 'ORG_MIGRATION_EMPLOYMENT_STATUS_MISMATCH',
          message: '劳动关系状态与员工主数据状态不一致',
        });
        const existing = await this.employments.findByOnboardingInstanceId(
          input.onboardingInstanceId,
          session,
        );
        if (existing !== null) {
          const existingPerson = await this.persons.findBySourceCandidateId(
            input.sourcePersonId,
            session,
          );
          if (existingPerson === null || !sameEmploymentMigrationFact(existing, existingPerson, input)) {
            throw new ConflictException({
              code: 'ORG_MIGRATION_EMPLOYMENT_IMMUTABLE',
              message: '既有劳动关系与迁移快照不一致，禁止覆盖历史事实',
            });
          }
          return { employment: existing, personId: existingPerson.id };
        }

        const now = new Date();
        const tenantId = this.context.getTenantRequired().tenantId;
        let person = await this.persons.findBySourceCandidateId(input.sourcePersonId, session);
        let personCreated = false;
        if (person === null) {
          person = createPerson({
            id: createEventId(now), tenantId,
            sourceCandidateId: input.sourcePersonId,
            identityEvidenceId: input.identityEvidenceId,
          }, now);
          personCreated = true;
        } else if (person.identityEvidenceId !== input.identityEvidenceId) {
          throw new ConflictException({
            code: 'ORG_PERSON_IDENTITY_EVIDENCE_MISMATCH',
            message: '自然人来源已绑定不同身份核验证据，必须人工复核',
          });
        }
        const employment = restoreEmploymentFromMigration({
          id: createEventId(now), tenantId, personId: person.id,
          employeeId: input.employeeId,
          onboardingInstanceId: input.onboardingInstanceId,
          onboardingCompletionEvidenceId: input.onboardingCompletionEvidenceId,
          offerId: input.offerId,
          signedEvidenceId: input.signedEvidenceId,
          status: input.status,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          terminationCareCaseId: input.terminationCareCaseId,
          terminationExecutionEvidenceId: input.terminationExecutionEvidenceId,
          terminationEvidenceId: input.terminationEvidenceId,
        }, now);
        if (personCreated) {
          await this.persons.insert(person, session);
          await this.outbox.append(buildPersonCreatedEvent(person, now), session);
        }
        await this.employments.insert(employment, session);
        await this.outbox.append(buildEmploymentEstablishedEvent(employment, now), session);
        return { employment, personId: person.id };
      },
    ));
  }

  /** Onboarding 组织分配任务专用：只校验权威组织引用，不暴露组织仓储。 */
  async validateOnboardingAssignment(input: {
    readonly departmentId: string;
    readonly orgPositionId: string;
    readonly jobLevelId: string | null;
  }): Promise<{ readonly verified: true }> {
    this.assertTrustedScope('erp:onboarding:org:validate');
    const [department, position, jobLevel] = await Promise.all([
      this.departments.findById(input.departmentId),
      this.positions.findById(input.orgPositionId),
      input.jobLevelId === null ? Promise.resolve(null) : this.jobLevels.findById(input.jobLevelId),
    ]);
    if (department === null || department.status !== 'active') throw new BadRequestException({
      code: 'ORG_INVALID_DEPARTMENT_REFERENCE', message: '入职部门不存在或未启用',
    });
    if (position === null || position.status !== 'active') throw new BadRequestException({
      code: 'ORG_INVALID_POSITION_REFERENCE', message: '入职岗位不存在或未启用',
    });
    if (input.jobLevelId !== null && jobLevel === null) throw new BadRequestException({
      code: 'ORG_INVALID_JOB_LEVEL_REFERENCE', message: '入职职级不存在',
    });
    return { verified: true };
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

  /** 数据迁移专用：在一个事务内同步员工资料、状态与开放劳动关系。 */
  async synchronizeEmployeeFromMigration(
    id: string,
    expectedVersion: number,
    key: string,
    input: CreateEmployeeDto,
  ): Promise<{ readonly employee: Employee }> {
    this.assertTrustedScope('erp:migration:execute');
    return this.run(async () => this.idempotency.execute(
      'org.employee.synchronize_from_migration',
      key,
      { id, expectedVersion, input },
      async (session) => {
        const current = await this.requireEmployee(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        if (input.status === 'terminated' && current.status !== 'terminated') {
          throw new ConflictException({
            code: 'ORG_CARE_WORKFLOW_REQUIRED',
            message: '既有员工离职必须通过 Care 清算与生效日编排',
          });
        }
        const now = new Date();
        const updated = updateEmployee(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          employeeNo: input.employeeNo,
          displayName: input.displayName,
          departmentIds: input.departmentIds,
          primaryDepartmentId: input.primaryDepartmentId,
          positionIds: input.positionIds ?? [],
          jobLevelId: input.jobLevelId ?? null,
        }, now);
        await this.assertEmployeeReferences(updated, session);

        let employee = updated;
        let employmentChange: {
          readonly before: Employment;
          readonly after: Employment;
        } | null = null;
        const desiredStatus = input.status ?? current.status;
        if (desiredStatus !== current.status) {
          employee = transitionEmployeeStatus(updated, desiredStatus, now);
          const currentEmployment = await this.employments.findOpenByEmployeeId(id, session);
          if (currentEmployment !== null) {
            if (employee.status !== 'active' && employee.status !== 'suspended') {
              throw new ConflictException({
                code: 'ORG_EMPLOYMENT_STATUS_SYNC_INVALID',
                message: '当前员工状态不能同步到劳动关系',
              });
            }
            employmentChange = {
              before: currentEmployment,
              after: transitionEmploymentStatus(currentEmployment, {
                tenantId: this.context.getTenantRequired().tenantId,
                expectedVersion: currentEmployment.version,
                status: employee.status,
              }, now),
            };
          }
        }

        if (employmentChange !== null) {
          await this.employments.replace(
            employmentChange.after, employmentChange.before.version, session,
          );
        }
        await this.employees.replace(employee, expectedVersion, session);
        await this.outbox.append(buildEmployeeUpdatedEvent(updated, now), session);
        if (employmentChange !== null) {
          await this.outbox.append(buildEmploymentStatusChangedEvent(
            employmentChange.after, employmentChange.before.status, now,
          ), session);
        }
        if (employee.status !== current.status) {
          await this.outbox.append(
            buildEmployeeStatusChangedEvent(employee, current.status, now), session,
          );
        }
        return { employee };
      },
    ));
  }

  async transitionEmployeeStatus(
    id: string,
    expectedVersion: number,
    key: string,
    input: TransitionEmployeeStatusDto,
  ): Promise<{
    readonly employee: Employee;
    readonly identityTermination?: EmployeeIdentityTerminationResult;
  }> {
    if (input.status === 'terminated') throw new ConflictException({
      code: 'ORG_CARE_WORKFLOW_REQUIRED', message: '员工离职必须通过 Care 清算与生效日编排',
    });
    return this.run(async () => this.idempotency.execute(
      'org.employee.status_transition',
      key,
      { id, expectedVersion, input },
      async (session) => {
        const current = await this.requireEmployee(id, session);
        this.assertExpectedVersion(current.version, expectedVersion);
        const currentEmployment = await this.employments.findOpenByEmployeeId(id, session);
        const now = new Date();
        const employee = transitionEmployeeStatus(current, input.status, now);
        if (currentEmployment !== null) {
          if (employee.status !== 'active' && employee.status !== 'suspended') {
            throw new ConflictException({
              code: 'ORG_EMPLOYMENT_STATUS_SYNC_INVALID',
              message: '当前员工状态不能同步到劳动关系',
            });
          }
          const employment = transitionEmploymentStatus(currentEmployment, {
            tenantId: this.context.getTenantRequired().tenantId,
            expectedVersion: currentEmployment.version, status: employee.status,
          }, now);
          await this.employments.replace(employment, currentEmployment.version, session);
          await this.outbox.append(
            buildEmploymentStatusChangedEvent(employment, currentEmployment.status, now), session,
          );
        }
        await this.employees.replace(employee, expectedVersion, session);
        await this.outbox.append(
          buildEmployeeStatusChangedEvent(employee, current.status, now),
          session,
        );
        return { employee };
      },
    ));
  }

  /** Care 专用：同一事务关闭 Employment、终止 Employee、吊销全部身份并发布主数据事件。 */
  async terminateEmploymentFromCare(
    key: string,
    input: {
      readonly careCaseId: string;
      readonly employeeId: string;
      readonly employmentId: string;
      readonly effectiveTo: string;
      readonly executionEvidenceId: string;
    },
  ): Promise<{
    readonly employee: Employee;
    readonly employment: Employment;
    readonly terminationEvidenceId: string;
    readonly identityTermination?: EmployeeIdentityTerminationResult;
  }> {
    this.assertTrustedScope('erp:care:employment:terminate');
    return this.run(async () => this.idempotency.execute(
      'org.employment.terminate_from_care', key, input, async (session) => {
        const [currentEmployee, currentEmployment] = await Promise.all([
          this.requireEmployee(input.employeeId, session),
          this.employments.findById(input.employmentId, session),
        ]);
        if (currentEmployment === null) throw new NotFoundException({
          code: 'ORG_EMPLOYMENT_NOT_FOUND', message: '劳动关系不存在',
        });
        if (currentEmployment.employeeId !== currentEmployee.id) throw new ConflictException({
          code: 'ORG_CARE_EMPLOYMENT_MISMATCH', message: '离职案件员工与劳动关系不一致',
        });
        if (currentEmployment.status === 'resigned') {
          if (
            currentEmployee.status !== 'terminated' ||
            currentEmployment.terminationCareCaseId !== input.careCaseId ||
            currentEmployment.terminationExecutionEvidenceId !== input.executionEvidenceId ||
            currentEmployment.effectiveTo !== input.effectiveTo ||
            currentEmployment.terminationEvidenceId === null
          ) throw new ConflictException({
            code: 'ORG_CARE_TERMINATION_MISMATCH', message: '劳动关系已由其他事实关闭',
          });
          return {
            employee: currentEmployee, employment: currentEmployment,
            terminationEvidenceId: currentEmployment.terminationEvidenceId,
          };
        }
        if (currentEmployee.status === 'terminated') throw new ConflictException({
          code: 'ORG_LEGACY_TERMINATION_INCONSISTENT',
          message: '员工已离职但劳动关系仍开放，必须进入数据修复流程',
        });
        const now = new Date();
        const terminationEvidenceId = createEventId(now);
        const employee = transitionEmployeeStatus(currentEmployee, 'terminated', now);
        const employment = terminateEmployment(currentEmployment, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion: currentEmployment.version, effectiveTo: input.effectiveTo,
          careCaseId: input.careCaseId, executionEvidenceId: input.executionEvidenceId,
          terminationEvidenceId,
        }, now);
        const identityTermination = await this.identities.terminateEmployee(
          currentEmployee.tenantId, currentEmployee.id, session,
        );
        await this.employments.replace(employment, currentEmployment.version, session);
        await this.employees.replace(employee, currentEmployee.version, session);
        await this.outbox.append(buildEmploymentTerminatedEvent(employment, now), session);
        await this.outbox.append(
          buildEmployeeStatusChangedEvent(employee, currentEmployee.status, now), session,
        );
        return { employee, employment, terminationEvidenceId, identityTermination };
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

  private async requireEmployee(id: string, session?: ClientSession): Promise<Employee> {
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

  private assertTrustedScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ORG_TRUSTED_WORKFLOW_REQUIRED', message: '必须由受信任的生命周期工作流执行',
    });
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

function sameEmploymentMigrationFact(
  employment: Employment,
  person: {
    readonly id: string;
    readonly sourceCandidateId: string;
    readonly identityEvidenceId: string;
  },
  input: ImportEmploymentFromMigrationInput,
): boolean {
  return person.sourceCandidateId === input.sourcePersonId &&
    person.identityEvidenceId === input.identityEvidenceId &&
    employment.personId === person.id &&
    employment.employeeId === input.employeeId &&
    employment.onboardingInstanceId === input.onboardingInstanceId &&
    employment.onboardingCompletionEvidenceId === input.onboardingCompletionEvidenceId &&
    employment.offerId === input.offerId &&
    employment.signedEvidenceId === input.signedEvidenceId &&
    employment.status === input.status &&
    employment.effectiveFrom === input.effectiveFrom &&
    employment.effectiveTo === input.effectiveTo &&
    employment.terminationCareCaseId === input.terminationCareCaseId &&
    employment.terminationExecutionEvidenceId === input.terminationExecutionEvidenceId &&
    employment.terminationEvidenceId === input.terminationEvidenceId;
}
