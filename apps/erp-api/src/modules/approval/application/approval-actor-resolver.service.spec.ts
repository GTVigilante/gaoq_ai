import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { DepartmentRepository, EmployeeRepository } from '../../org/persistence/org.repositories.js';
import {
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  snapshotApprovalTemplate,
  type ApprovalTemplateDefinition,
} from '../domain/template.js';
import { ApprovalActorResolverService } from './approval-actor-resolver.service.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;

function snapshot() {
  const definition: ApprovalTemplateDefinition = {
    fields: [{ key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' }],
    nodes: [
      {
        id: 'manager', name: '部门负责人', type: 'approval', approvalMode: 'all',
        resolver: { type: 'initiator_manager' },
      },
      {
        id: 'finance', name: '财务', type: 'approval', approvalMode: 'any',
        resolver: { type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'tenant' },
        condition: { op: 'gte', field: 'amount', value: 100_00 },
      },
    ],
  };
  const draft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
    riskLevel: 'R2', definition, actorId: 'editor-001',
  }, NOW);
  return snapshotApprovalTemplate(publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW));
}

describe('ApprovalActorResolverService', () => {
  it('只使用可信租户上下文，并按条件解析部门负责人和有效角色主体', async () => {
    const context = {
      getTenantRequired: () => ({ tenantId: 'tenant-001' }),
    } as unknown as TenantContextService;
    const findActiveByRoles = vi.fn().mockResolvedValue([
      { actorId: 'finance-actor', employeeId: 'finance-employee' },
    ]);
    const profiles = {
      resolveActive: vi.fn()
        .mockResolvedValueOnce({ employeeId: 'employee-001', departmentIds: ['department-001'] })
        .mockResolvedValueOnce({ actorId: 'manager-actor' }),
      findActorIdByEmployee: vi.fn().mockResolvedValue('manager-actor'),
      findActiveByRoles,
    } as unknown as AccessProfileRepository;
    const employees = {
      findById: vi.fn().mockImplementation((id: string) => Promise.resolve(id === 'employee-001'
        ? { id, status: 'active', primaryDepartmentId: 'department-001' }
        : { id, status: 'active', primaryDepartmentId: 'finance-department' })),
    } as unknown as EmployeeRepository;
    const departments = {
      findById: vi.fn().mockResolvedValue({
        id: 'department-001', status: 'active', managerId: 'manager-employee',
      }),
    } as unknown as DepartmentRepository;
    const resolver = new ApprovalActorResolverService(context, profiles, employees, departments);

    const result = await resolver.resolve(snapshot(), 'initiator-actor', { amount: 200_00 }, SESSION);

    expect(result).toEqual([
      { nodeId: 'manager', actorIds: ['manager-actor'] },
      { nodeId: 'finance', actorIds: ['finance-actor'] },
    ]);
    expect(findActiveByRoles).toHaveBeenCalledWith(
      'tenant-001', ['FINANCE_APPROVER'], null, SESSION,
    );
  });

  it('条件未命中的节点不触发组织查询', async () => {
    const findActiveByRoles = vi.fn();
    const profiles = {
      resolveActive: vi.fn().mockResolvedValue({
        employeeId: 'employee-001', departmentIds: ['department-001'],
      }),
      findActorIdByEmployee: vi.fn().mockResolvedValue('manager-actor'),
      findActiveByRoles,
    } as unknown as AccessProfileRepository;
    const employees = {
      findById: vi.fn().mockResolvedValue({
        status: 'active', primaryDepartmentId: 'department-001',
      }),
    } as unknown as EmployeeRepository;
    const departments = {
      findById: vi.fn().mockResolvedValue({ status: 'active', managerId: 'manager-employee' }),
    } as unknown as DepartmentRepository;
    const resolver = new ApprovalActorResolverService(
      { getTenantRequired: () => ({ tenantId: 'tenant-001' }) } as unknown as TenantContextService,
      profiles,
      employees,
      departments,
    );
    const result = await resolver.resolve(snapshot(), 'initiator-actor', { amount: 50_00 }, SESSION);
    expect(result.map((node) => node.nodeId)).toEqual(['manager']);
    expect(findActiveByRoles).not.toHaveBeenCalled();
  });
});
