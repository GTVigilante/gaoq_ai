import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OrgPersonBirthdayBlindIndexService } from '../persistence/org-person-birthday-blind-index.service.js';
import {
  EmployeeRepository,
  EmploymentRepository,
  PersonRepository,
} from '../persistence/org.repositories.js';

export interface OrgCareOccasionSource {
  readonly personId: string;
  readonly employeeId: string;
  readonly currentEmploymentId: string;
  readonly departmentIds: readonly string[];
  /** 仅在 Care 应用服务内使用，不得进入事件、队列、日志、审计或 MCP。 */
  readonly birthdayMonthDay: string | null;
  /** 生日盲索引摘要仅用于检测更正，不得作为查询索引或对外返回。 */
  readonly birthdaySourceRevision: string | null;
  /** 包含复聘历史；策略层决定采用当前段还是最早一段。 */
  readonly employmentEffectiveFromDates: readonly string[];
  readonly currentEmploymentEffectiveFrom: string;
}

/** Care 只通过该窄口读取权威 Person/Employment 事实，不直接访问组织仓储。 */
@Injectable()
export class OrgCareOccasionSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly employees: EmployeeRepository,
    private readonly employments: EmploymentRepository,
    private readonly persons: PersonRepository,
    private readonly birthdayBlindIndex: OrgPersonBirthdayBlindIndexService,
  ) {}

  async getEligibleByEmployeeId(employeeId: string): Promise<OrgCareOccasionSource | null> {
    this.assertScope();
    const employee = await this.employees.findById(employeeId);
    if (
      employee === null ||
      !['probation', 'active'].includes(employee.status)
    ) return null;
    const current = await this.employments.findOpenByEmployeeId(employeeId);
    if (
      current === null ||
      !['probation', 'active'].includes(current.status)
    ) return null;
    const [personProjection, histories] = await Promise.all([
      this.persons.findBirthdayProjectionById(current.personId),
      this.employments.findByPersonId(current.personId),
    ]);
    if (personProjection === null || personProjection.person.status !== 'active') return null;
    const birthdayMonthDay = personProjection.person.birthdayEvidenceId === null
      ? null
      : this.birthdayBlindIndex.resolveMonthDay(
          this.context.getTenantRequired().tenantId,
          personProjection.birthdayBlindIndexes,
        );
    if (
      personProjection.person.birthdayEvidenceId !== null &&
      birthdayMonthDay === null
    ) {
      throw new Error('ORG_PERSON_BIRTHDAY_PROJECTION_UNRESOLVABLE');
    }
    return Object.freeze({
      personId: current.personId,
      employeeId: employee.id,
      currentEmploymentId: current.id,
      departmentIds: Object.freeze([...employee.departmentIds]),
      birthdayMonthDay,
      birthdaySourceRevision: personProjection.birthdayBlindIndexes.length === 0
        ? null
        : createHash('sha256').update(JSON.stringify([
            'gaoq-care-birthday-source-revision-v1',
            ...[...personProjection.birthdayBlindIndexes].sort(),
          ]), 'utf8').digest('base64url'),
      employmentEffectiveFromDates: Object.freeze(
        histories.map((employment) => employment.effectiveFrom).sort(),
      ),
      currentEmploymentEffectiveFrom: current.effectiveFrom,
    });
  }

  private assertScope(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:care:occasion:source:read')) {
      throw new ForbiddenException({
        code: 'ORG_CARE_OCCASION_SOURCE_DENIED',
        message: '缺少关怀主数据读取权限',
      });
    }
  }
}
