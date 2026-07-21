import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { DepartmentRepository, EmployeeRepository } from '../../org/persistence/org.repositories.js';
import { evaluateApprovalCondition, type ApprovalFormData } from '../domain/condition.js';
import { ApprovalDomainError } from '../domain/approval.errors.js';
import type { ResolvedApprovalNodeInput } from '../domain/instance.js';
import type { ApprovalActorResolver, ApprovalTemplateSnapshot } from '../domain/template.js';

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
    if (initiatorActorId.length < 1) throw resolutionError('发起主体无效');
    const tenantId = this.context.getTenantRequired().tenantId;
    const initiator = await this.profiles.resolveActive(tenantId, initiatorActorId, session);
    if (initiator === null) throw resolutionError('发起人授权快照不存在或已停用');
    const fieldKeys = new Set(snapshot.definition.fields.map((field) => field.key));
    const activeNodes = snapshot.definition.nodes.filter((node) =>
      node.condition === undefined || evaluateApprovalCondition(node.condition, formData, fieldKeys),
    );
    const results: ResolvedApprovalNodeInput[] = [];
    for (const node of activeNodes) {
      const actorIds = await this.resolveRule(
        tenantId,
        node.resolver,
        initiator.employeeId,
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
    initiatorEmployeeId: string,
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
        const active = await Promise.all(profiles.map(async (profile) =>
          await this.activeEmployee(profile.employeeId, session) ? profile.actorId : null));
        return unique(active.filter((actorId): actorId is string => actorId !== null));
      }
      case 'initiator_manager': {
        const employee = await this.employees.findById(initiatorEmployeeId, session);
        if (employee === null) return [];
        return this.departmentManagerActor(tenantId, employee.primaryDepartmentId, session);
      }
      case 'department_manager': {
        const departmentId = formData[resolver.departmentField];
        if (typeof departmentId !== 'string') throw resolutionError('部门负责人规则字段值无效');
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
    if (department === null || department.status !== 'active' || department.managerId === null) return [];
    return this.employeeIdsToActors(tenantId, [department.managerId], session);
  }

  private async employeeIdsToActors(
    tenantId: string,
    employeeIds: readonly string[],
    session: ClientSession,
  ): Promise<string[]> {
    const actors = await Promise.all(employeeIds.map(async (employeeId) => {
      if (!await this.activeEmployee(employeeId, session)) return null;
      const actorId = await this.profiles.findActorIdByEmployee(tenantId, employeeId, session);
      if (actorId === null) return null;
      const profile = await this.profiles.resolveActive(tenantId, actorId, session);
      return profile === null ? null : actorId;
    }));
    return unique(actors.filter((actorId): actorId is string => actorId !== null));
  }

  private async activeEmployee(employeeId: string, session: ClientSession): Promise<boolean> {
    const employee = await this.employees.findById(employeeId, session);
    return employee !== null && (employee.status === 'active' || employee.status === 'probation');
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function resolutionError(message: string): ApprovalDomainError {
  return new ApprovalDomainError('APPROVAL_ACTOR_RESOLUTION_FAILED', message);
}
