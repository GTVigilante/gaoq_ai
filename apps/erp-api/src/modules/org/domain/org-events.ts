import type { Department } from './department.js';
import type { Employee, EmployeeStatus } from './employee.js';
import type { JobLevel } from './job-level.js';
import type { Position } from './position.js';
import type { Person } from './person.js';
import type { Employment } from './employment.js';

/**
 * 组织领域事件。
 * 红线：payload 只允许标识、编码、名称、状态等非敏感字段，
 * 严禁包含手机号、身份证、银行账号、薪资等敏感信息。
 */

/** 事件公共信封。 */
export interface OrgEventBase<TType extends string, TPayload> {
  readonly type: TType;
  readonly tenantId: string;
  readonly aggregateId: string;
  /** 事件产生时的聚合版本号。 */
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** department.created 载荷。 */
export interface DepartmentCreatedPayload {
  readonly code: string;
  readonly name: string;
  readonly status: Department['status'];
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly sortOrder: number;
}

/** department.updated 载荷。 */
export interface DepartmentUpdatedPayload {
  readonly code: string;
  readonly name: string;
  readonly status: Department['status'];
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly sortOrder: number;
}

/** employee.created 载荷（不含任何敏感字段）。 */
export interface EmployeeCreatedPayload {
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: EmployeeStatus;
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
}

/** employee.updated 载荷（不含任何敏感字段）。 */
export interface EmployeeUpdatedPayload {
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: EmployeeStatus;
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
}

/** employee.status_changed 载荷。 */
export interface EmployeeStatusChangedPayload {
  readonly fromStatus: EmployeeStatus;
  readonly toStatus: EmployeeStatus;
}

export interface PersonCreatedPayload {
  readonly sourceCandidateId: string;
  readonly status: Person['status'];
}

export interface PersonBirthdayAttestedPayload {
  readonly birthdayEvidenceId: string;
  readonly status: Person['status'];
}

export interface EmploymentEstablishedPayload {
  readonly personId: string;
  readonly employeeId: string;
  readonly onboardingInstanceId: string;
  readonly offerId: string;
  readonly status: Employment['status'];
  readonly effectiveFrom: string;
}

export interface EmploymentTerminatedPayload {
  readonly personId: string;
  readonly employeeId: string;
  readonly careCaseId: string;
  readonly status: Employment['status'];
  readonly effectiveTo: string;
}

export interface EmploymentStatusChangedPayload {
  readonly employeeId: string;
  readonly fromStatus: Employment['status'];
  readonly toStatus: Employment['status'];
}

/** position.created 载荷。 */
export interface PositionCreatedPayload {
  readonly code: string;
  readonly name: string;
  readonly status: Position['status'];
}

/** position.updated 载荷。 */
export interface PositionUpdatedPayload {
  readonly code: string;
  readonly name: string;
  readonly status: Position['status'];
}

/** job_level.created 载荷。 */
export interface JobLevelCreatedPayload {
  readonly code: string;
  readonly name: string;
  readonly track: JobLevel['track'];
  readonly rank: number;
}

/** job_level.updated 载荷。 */
export interface JobLevelUpdatedPayload {
  readonly code: string;
  readonly name: string;
  readonly track: JobLevel['track'];
  readonly rank: number;
}

export type DepartmentCreatedEvent = OrgEventBase<'department.created', DepartmentCreatedPayload>;
export type DepartmentUpdatedEvent = OrgEventBase<'department.updated', DepartmentUpdatedPayload>;
export type EmployeeCreatedEvent = OrgEventBase<'employee.created', EmployeeCreatedPayload>;
export type EmployeeUpdatedEvent = OrgEventBase<'employee.updated', EmployeeUpdatedPayload>;
export type EmployeeStatusChangedEvent = OrgEventBase<
  'employee.status_changed',
  EmployeeStatusChangedPayload
>;
export type PersonCreatedEvent = OrgEventBase<'person.created', PersonCreatedPayload>;
export type PersonBirthdayAttestedEvent = OrgEventBase<
  'person.birthday_attested',
  PersonBirthdayAttestedPayload
>;
export type EmploymentEstablishedEvent = OrgEventBase<
  'employment.established',
  EmploymentEstablishedPayload
>;
export type EmploymentTerminatedEvent = OrgEventBase<
  'employment.terminated',
  EmploymentTerminatedPayload
>;
export type EmploymentStatusChangedEvent = OrgEventBase<
  'employment.status_changed',
  EmploymentStatusChangedPayload
>;
export type PositionCreatedEvent = OrgEventBase<'position.created', PositionCreatedPayload>;
export type PositionUpdatedEvent = OrgEventBase<'position.updated', PositionUpdatedPayload>;
export type JobLevelCreatedEvent = OrgEventBase<'job_level.created', JobLevelCreatedPayload>;
export type JobLevelUpdatedEvent = OrgEventBase<'job_level.updated', JobLevelUpdatedPayload>;

/** 组织领域事件联合类型。 */
export type OrgDomainEvent =
  | DepartmentCreatedEvent
  | DepartmentUpdatedEvent
  | EmployeeCreatedEvent
  | EmployeeUpdatedEvent
  | EmployeeStatusChangedEvent
  | PersonCreatedEvent
  | PersonBirthdayAttestedEvent
  | EmploymentEstablishedEvent
  | EmploymentTerminatedEvent
  | EmploymentStatusChangedEvent
  | PositionCreatedEvent
  | PositionUpdatedEvent
  | JobLevelCreatedEvent
  | JobLevelUpdatedEvent;

/** 组织领域事件类型字面量。 */
export type OrgDomainEventType = OrgDomainEvent['type'];

/** 构造 department.created 事件。 */
export function buildDepartmentCreatedEvent(
  department: Department,
  occurredAt: Date,
): DepartmentCreatedEvent {
  return {
    type: 'department.created',
    tenantId: department.tenantId,
    aggregateId: department.id,
    version: department.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      code: department.code,
      name: department.name,
      status: department.status,
      parentId: department.parentId,
      managerId: department.managerId,
      sortOrder: department.sortOrder,
    },
  };
}

/** 构造 department.updated 事件。 */
export function buildDepartmentUpdatedEvent(
  department: Department,
  occurredAt: Date,
): DepartmentUpdatedEvent {
  return {
    type: 'department.updated',
    tenantId: department.tenantId,
    aggregateId: department.id,
    version: department.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      code: department.code,
      name: department.name,
      status: department.status,
      parentId: department.parentId,
      managerId: department.managerId,
      sortOrder: department.sortOrder,
    },
  };
}

/** 构造 employee.created 事件（payload 仅含非敏感字段）。 */
export function buildEmployeeCreatedEvent(
  employee: Employee,
  occurredAt: Date,
): EmployeeCreatedEvent {
  return {
    type: 'employee.created',
    tenantId: employee.tenantId,
    aggregateId: employee.id,
    version: employee.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      employeeNo: employee.employeeNo,
      displayName: employee.displayName,
      status: employee.status,
      departmentIds: [...employee.departmentIds],
      primaryDepartmentId: employee.primaryDepartmentId,
      positionIds: [...employee.positionIds],
      jobLevelId: employee.jobLevelId,
    },
  };
}

/** 构造 employee.updated 事件（payload 仅含非敏感字段）。 */
export function buildEmployeeUpdatedEvent(
  employee: Employee,
  occurredAt: Date,
): EmployeeUpdatedEvent {
  return {
    type: 'employee.updated',
    tenantId: employee.tenantId,
    aggregateId: employee.id,
    version: employee.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      employeeNo: employee.employeeNo,
      displayName: employee.displayName,
      status: employee.status,
      departmentIds: [...employee.departmentIds],
      primaryDepartmentId: employee.primaryDepartmentId,
      positionIds: [...employee.positionIds],
      jobLevelId: employee.jobLevelId,
    },
  };
}

/** 构造 employee.status_changed 事件。 */
export function buildEmployeeStatusChangedEvent(
  employee: Employee,
  fromStatus: EmployeeStatus,
  occurredAt: Date,
): EmployeeStatusChangedEvent {
  return {
    type: 'employee.status_changed',
    tenantId: employee.tenantId,
    aggregateId: employee.id,
    version: employee.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      fromStatus,
      toStatus: employee.status,
    },
  };
}

export function buildPersonCreatedEvent(person: Person, occurredAt: Date): PersonCreatedEvent {
  return {
    type: 'person.created', tenantId: person.tenantId, aggregateId: person.id,
    version: person.version, occurredAt: occurredAt.toISOString(),
    payload: { sourceCandidateId: person.sourceCandidateId, status: person.status },
  };
}

/** 生日月日不进入事件；消费者只能获知证明已建立。 */
export function buildPersonBirthdayAttestedEvent(
  person: Person,
  occurredAt: Date,
): PersonBirthdayAttestedEvent {
  if (person.birthdayEvidenceId === null || person.birthdayAttestedAt === null) {
    throw new Error('自然人生日证明事件缺少可信证据');
  }
  return {
    type: 'person.birthday_attested',
    tenantId: person.tenantId,
    aggregateId: person.id,
    version: person.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      birthdayEvidenceId: person.birthdayEvidenceId,
      status: person.status,
    },
  };
}

export function buildEmploymentEstablishedEvent(
  employment: Employment,
  occurredAt: Date,
): EmploymentEstablishedEvent {
  return {
    type: 'employment.established', tenantId: employment.tenantId,
    aggregateId: employment.id, version: employment.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      personId: employment.personId, employeeId: employment.employeeId,
      onboardingInstanceId: employment.onboardingInstanceId, offerId: employment.offerId,
      status: employment.status, effectiveFrom: employment.effectiveFrom,
    },
  };
}

export function buildEmploymentTerminatedEvent(
  employment: Employment,
  occurredAt: Date,
): EmploymentTerminatedEvent {
  if (
    employment.terminationCareCaseId === null || employment.effectiveTo === null ||
    employment.terminationEvidenceId === null
  ) throw new Error('劳动关系终止事件缺少可信证明');
  return {
    type: 'employment.terminated', tenantId: employment.tenantId,
    aggregateId: employment.id, version: employment.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      personId: employment.personId, employeeId: employment.employeeId,
      careCaseId: employment.terminationCareCaseId,
      status: employment.status, effectiveTo: employment.effectiveTo,
    },
  };
}

export function buildEmploymentStatusChangedEvent(
  employment: Employment,
  fromStatus: Employment['status'],
  occurredAt: Date,
): EmploymentStatusChangedEvent {
  return {
    type: 'employment.status_changed', tenantId: employment.tenantId,
    aggregateId: employment.id, version: employment.version,
    occurredAt: occurredAt.toISOString(), payload: {
      employeeId: employment.employeeId, fromStatus, toStatus: employment.status,
    },
  };
}

/** 构造 position.created 事件。 */
export function buildPositionCreatedEvent(position: Position, occurredAt: Date): PositionCreatedEvent {
  return {
    type: 'position.created',
    tenantId: position.tenantId,
    aggregateId: position.id,
    version: position.version,
    occurredAt: occurredAt.toISOString(),
    payload: { code: position.code, name: position.name, status: position.status },
  };
}

/** 构造 position.updated 事件。 */
export function buildPositionUpdatedEvent(position: Position, occurredAt: Date): PositionUpdatedEvent {
  return {
    type: 'position.updated',
    tenantId: position.tenantId,
    aggregateId: position.id,
    version: position.version,
    occurredAt: occurredAt.toISOString(),
    payload: { code: position.code, name: position.name, status: position.status },
  };
}

/** 构造 job_level.created 事件。 */
export function buildJobLevelCreatedEvent(jobLevel: JobLevel, occurredAt: Date): JobLevelCreatedEvent {
  return {
    type: 'job_level.created',
    tenantId: jobLevel.tenantId,
    aggregateId: jobLevel.id,
    version: jobLevel.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      code: jobLevel.code,
      name: jobLevel.name,
      track: jobLevel.track,
      rank: jobLevel.rank,
    },
  };
}

/** 构造 job_level.updated 事件。 */
export function buildJobLevelUpdatedEvent(jobLevel: JobLevel, occurredAt: Date): JobLevelUpdatedEvent {
  return {
    type: 'job_level.updated',
    tenantId: jobLevel.tenantId,
    aggregateId: jobLevel.id,
    version: jobLevel.version,
    occurredAt: occurredAt.toISOString(),
    payload: {
      code: jobLevel.code,
      name: jobLevel.name,
      track: jobLevel.track,
      rank: jobLevel.rank,
    },
  };
}
