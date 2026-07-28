import { ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { EmployeeStatus } from '../domain/employee.js';
import type { EmploymentStatus } from '../domain/employment.js';
import {
  EmployeeRepository,
  EmploymentRepository,
  PersonRepository,
} from '../persistence/org.repositories.js';

export interface OrgTalentEmployment {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly employeeStatus: EmployeeStatus;
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly status: EmploymentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly onboardingInstanceId: string;
  readonly offerId: string;
  readonly careCaseId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrgTalentSnapshot {
  readonly personId: string;
  readonly personStatus: 'active' | 'inactive';
  readonly employments: readonly OrgTalentEmployment[];
}

/** 人才全景的组织域窄查询口；ERP 仍是 Person、Employee、Employment 唯一事实源。 */
@Injectable()
export class OrgTalentSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly persons: PersonRepository,
    private readonly employments: EmploymentRepository,
    private readonly employees: EmployeeRepository,
  ) {}

  async getByCandidateId(candidateId: string): Promise<OrgTalentSnapshot | null> {
    this.assertScope();
    const tenantId = this.context.getTenantRequired().tenantId;
    const person = await this.persons.findBySourceCandidateId(candidateId);
    if (person === null) return null;
    if (person.tenantId !== tenantId || person.sourceCandidateId !== candidateId) {
      throw new Error('TALENT_LIFECYCLE_PERSON_REFERENCE_INVALID');
    }
    const employments = await this.employments.findByPersonId(person.id);
    const values = await Promise.all(employments.map(async (employment) => {
      if (employment.tenantId !== tenantId || employment.personId !== person.id) {
        throw new Error('TALENT_LIFECYCLE_EMPLOYMENT_REFERENCE_INVALID');
      }
      const employee = await this.employees.findById(employment.employeeId);
      if (
        employee === null ||
        employee.tenantId !== tenantId ||
        employee.id !== employment.employeeId
      ) {
        throw new Error('TALENT_LIFECYCLE_EMPLOYEE_REFERENCE_INVALID');
      }
      return Object.freeze({
        id: employment.id,
        employeeId: employee.id,
        employeeNo: employee.employeeNo,
        displayName: employee.displayName,
        employeeStatus: employee.status,
        departmentIds: Object.freeze([...employee.departmentIds]),
        primaryDepartmentId: employee.primaryDepartmentId,
        status: employment.status,
        effectiveFrom: employment.effectiveFrom,
        effectiveTo: employment.effectiveTo,
        onboardingInstanceId: employment.onboardingInstanceId,
        offerId: employment.offerId,
        careCaseId: employment.terminationCareCaseId,
        createdAt: employment.createdAt,
        updatedAt: employment.updatedAt,
      });
    }));
    const actor = this.context.getActorRequired();
    const visible = actor.scopes.includes('erp:talent-lifecycle:read_all')
      ? values
      : values.filter((employment) =>
          employment.departmentIds.some((id) => actor.departmentIds.includes(id)),
        );
    if (employments.length > 0 && visible.length === 0) return null;
    return Object.freeze({
      personId: person.id,
      personStatus: person.status,
      employments: Object.freeze(visible),
    });
  }

  private assertScope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:talent-lifecycle:read')) {
      throw new ForbiddenException({
        code: 'TALENT_LIFECYCLE_SCOPE_DENIED',
        message: '缺少人才全周期读取权限',
      });
    }
  }
}
