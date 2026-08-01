import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { Employee } from '../../org/domain/employee.js';
import { DepartmentRepository, EmployeeRepository } from '../../org/persistence/org.repositories.js';
import { evaluateApprovalCondition, type ApprovalFormData } from '../domain/condition.js';
import { ApprovalDomainError } from '../domain/approval.errors.js';
import type { ResolvedApprovalNodeInput } from '../domain/instance.js';
import type { ApprovalActorResolver, ApprovalTemplateSnapshot } from '../domain/template.js';
import { APPROVAL_ID_PATTERN } from '../domain/approval.validation.js';

const MAX_RESOLVED_ACTORS = 100;

/** 将模板审批人规则解析为提交时不可变主体快照；只读取 ERP 组织与身份主数据。 */
@Injectable()
export class ApprovalActorResolverService {
  constructor(
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly employees: EmployeeRepository,
    private readonly departments: DepartmentRepository,
  ) {}

  async resolve(
    snapshot: ApprovalTemplateSnapshot,
    initiatorActorId: string,
    formData: ApprovalFormData,
    session: ClientSession,
  ): Promise<readonly ResolvedApprovalNodeInput[]> {
    if (!APPROVAL_ID_PATTERN.test(initiatorActorId)) throw resolutionError('发起主体无效');
    const tenantId = this.context.getTenantRequired().tenantId;
    const initiator = await this.profiles.resolveActive(tenantId, initiatorActorId, session);
    if (initiator === null) throw resolutionError('发起人授权快照不存在或已停用');
    assertProfileIntegrity(initiator, tenantId, initiatorActorId);
    if (initiator.departmentIds.length < 1) {
      throw resolutionError('发起人授权快照缺少部门范围');
    }
    const initiatorEmployee = await this.requireEmployee(
      tenantId,
      initiator.employeeId,
      session,
    );
    if (!isActiveEmployeeStatus(initiatorEmployee.status)) {
      throw resolutionError('发起员工不存在或非在职状态');
    }
    const fieldKeys = new Set(snapshot.definition.fields.map((field) => field.key));
    const activeNodes = snapshot.definition.nodes.filter((node) =>
      node.condition === undefined || evaluateApprovalCondition(node.condition, formData, fieldKeys),
    );
    const results: ResolvedApprovalNodeInput[] = [];
    for (const node of activeNodes) {
      const actorIds = await this.resolveRule(
        tenantId,
        node.resolver,
        initiatorEmployee.primaryDepartmentId,
        initiator.departmentIds,
        formData,
        session,
      );
      if (node.type === 'approval' && actorIds.length < 1) {
        throw resolutionError(`审批节点 ${node.id} 未解析到有效审批人`);
      }
      results.push(Object.freeze({ nodeId: node.id, actorIds: Object.freeze(actorIds) }));
    }
    return Object.freeze(results);
  }

  private async resolveRule(
    tenantId: string,
    resolver: ApprovalActorResolver,
    initiatorPrimaryDepartmentId: string,
    initiatorDepartmentIds: readonly string[],
    formData: ApprovalFormData,
    session: ClientSession,
  ): Promise<string[]> {
    switch (resolver.type) {
      case 'employees':
        return this.employeeIdsToActors(tenantId, resolver.employeeIds, session);
      case 'roles': {
        const profiles = await this.profiles.findActiveByRoles(
          tenantId,
          resolver.roleCodes,
          resolver.scope === 'tenant' ? null : initiatorDepartmentIds,
          session,
        );
        assertRoleProfilesIntegrity(profiles, tenantId);
        const active = await Promise.all(profiles.map(async (profile) =>
          await this.activeEmployee(tenantId, profile.employeeId, session) ? profile.actorId : null));
        return resolvedActors(active.filter((actorId): actorId is string => actorId !== null));
      }
      case 'initiator_manager':
        return this.departmentManagerActor(tenantId, initiatorPrimaryDepartmentId, session);
      case 'department_manager': {
        const departmentId = formData[resolver.departmentField];
        if (typeof departmentId !== 'string' || !APPROVAL_ID_PATTERN.test(departmentId)) {
          throw resolutionError('部门负责人规则字段值无效');
        }
        return this.departmentManagerActor(tenantId, departmentId, session);
      }
    }
  }

  private async departmentManagerActor(
    tenantId: string,
    departmentId: string,
    session: ClientSession,
  ): Promise<string[]> {
    const department = await this.departments.findById(departmentId, session);
    if (department === null) return [];
    if (
      department.id !== departmentId ||
      department.tenantId !== tenantId ||
      (department.status !== 'active' && department.status !== 'inactive') ||
      (department.managerId !== null && !APPROVAL_ID_PATTERN.test(department.managerId))
    ) throw resolutionError('部门主数据完整性校验失败');
    if (department.status !== 'active' || department.managerId === null) return [];
    return this.employeeIdsToActors(tenantId, [department.managerId], session);
  }

  private async employeeIdsToActors(
    tenantId: string,
    employeeIds: readonly string[],
    session: ClientSession,
  ): Promise<string[]> {
    if (
      employeeIds.length < 1 ||
      employeeIds.length > MAX_RESOLVED_ACTORS ||
      employeeIds.some((employeeId) => !APPROVAL_ID_PATTERN.test(employeeId)) ||
      new Set(employeeIds).size !== employeeIds.length
    ) throw resolutionError('审批员工集合无效');
    const actors = await Promise.all(employeeIds.map(async (employeeId) => {
      if (!await this.activeEmployee(tenantId, employeeId, session)) return null;
      const actorId = await this.profiles.findActorIdByEmployee(tenantId, employeeId, session);
      if (actorId === null) return null;
      if (!APPROVAL_ID_PATTERN.test(actorId)) throw resolutionError('员工授权主体标识无效');
      const profile = await this.profiles.resolveActive(tenantId, actorId, session);
      if (profile === null) return null;
      assertProfileIntegrity(profile, tenantId, actorId);
      if (profile.employeeId !== employeeId) {
        throw resolutionError('员工与授权主体映射不一致');
      }
      return actorId;
    }));
    return resolvedActors(actors.filter((actorId): actorId is string => actorId !== null));
  }

  private async activeEmployee(
    tenantId: string,
    employeeId: string,
    session: ClientSession,
  ): Promise<boolean> {
    const employee = await this.employees.findById(employeeId, session);
    if (employee === null) return false;
    assertEmployeeIntegrity(employee, tenantId, employeeId);
    return isActiveEmployeeStatus(employee.status);
  }

  private async requireEmployee(
    tenantId: string,
    employeeId: string,
    session: ClientSession,
  ): Promise<Employee> {
    const employee = await this.employees.findById(employeeId, session);
    if (employee === null) throw resolutionError('发起员工不存在或非在职状态');
    assertEmployeeIntegrity(employee, tenantId, employeeId);
    return employee;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function resolvedActors(values: readonly string[]): string[] {
  const actors = unique(values);
  if (actors.length > MAX_RESOLVED_ACTORS) {
    throw resolutionError('单个审批节点解析人数超过 100 人上限');
  }
  return actors;
}

function assertProfileIntegrity(
  profile: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly employeeId: string;
    readonly status: string;
    readonly departmentIds: readonly string[];
  },
  tenantId: string,
  expectedActorId?: string,
): void {
  if (
    profile.tenantId !== tenantId ||
    (expectedActorId !== undefined && profile.actorId !== expectedActorId) ||
    profile.status !== 'active' ||
    !APPROVAL_ID_PATTERN.test(profile.actorId) ||
    !APPROVAL_ID_PATTERN.test(profile.employeeId) ||
    !isValidIdArray(profile.departmentIds, 500)
  ) throw resolutionError('授权快照完整性校验失败');
}

function assertRoleProfilesIntegrity(
  profiles: readonly {
    readonly tenantId: string;
    readonly actorId: string;
    readonly employeeId: string;
    readonly status: string;
    readonly departmentIds: readonly string[];
  }[],
  tenantId: string,
): void {
  for (const profile of profiles) assertProfileIntegrity(profile, tenantId);
  if (
    new Set(profiles.map((profile) => profile.actorId)).size !== profiles.length ||
    new Set(profiles.map((profile) => profile.employeeId)).size !== profiles.length
  ) throw resolutionError('角色审批主体存在重复映射');
}

function assertEmployeeIntegrity(
  employee: {
    readonly id: string;
    readonly tenantId: string;
    readonly status: string;
    readonly primaryDepartmentId: string;
  },
  tenantId: string,
  expectedEmployeeId: string,
): void {
  if (
    employee.id !== expectedEmployeeId ||
    employee.tenantId !== tenantId ||
    !['active', 'probation', 'suspended', 'terminated'].includes(employee.status) ||
    !APPROVAL_ID_PATTERN.test(employee.primaryDepartmentId)
  ) throw resolutionError('员工主数据完整性校验失败');
}

function isActiveEmployeeStatus(status: string): boolean {
  return status === 'active' || status === 'probation';
}

function isValidIdArray(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item): item is string =>
      typeof item === 'string' && APPROVAL_ID_PATTERN.test(item)) &&
    new Set(value).size === value.length;
}

function resolutionError(message: string): ApprovalDomainError {
  return new ApprovalDomainError('APPROVAL_ACTOR_RESOLUTION_FAILED', message);
}
