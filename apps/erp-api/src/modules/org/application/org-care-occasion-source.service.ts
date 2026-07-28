import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  Employee,
  Employment,
  Person,
} from '../domain/index.js';
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
    const tenantId = this.assertTrustedScope();
    const employee = await this.employees.findById(employeeId);
    if (employee === null) return null;
    this.assertEmployeeReference(employee, employeeId, tenantId);
    if (!['probation', 'active'].includes(employee.status)) return null;
    const current = await this.employments.findOpenByEmployeeId(employeeId);
    if (current === null) return null;
    this.assertCurrentEmploymentReference(current, employeeId, tenantId);
    if (!['probation', 'active'].includes(current.status)) return null;
    const [personProjection, histories] = await Promise.all([
      this.persons.findBirthdayProjectionById(current.personId),
      this.employments.findByPersonId(current.personId),
    ]);
    if (personProjection === null) throw this.sourceReferenceInvalid();
    this.assertPersonReference(personProjection.person, current.personId, tenantId);
    this.assertEmploymentHistories(histories, current, tenantId);
    this.assertBirthdayProjection(
      personProjection.person,
      personProjection.birthdayBlindIndexes,
    );
    const birthdayMonthDay = personProjection.person.birthdayEvidenceId === null
      ? null
      : this.birthdayBlindIndex.resolveMonthDay(
          tenantId,
          personProjection.birthdayBlindIndexes,
        );
    if (
      personProjection.person.birthdayEvidenceId !== null &&
      birthdayMonthDay === null
    ) {
      throw this.sourceReferenceInvalid();
    }
    return Object.freeze({
      personId: current.personId,
      employeeId: employee.id,
      currentEmploymentId: current.id,
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

  private assertTrustedScope(): string {
    const tenantId = this.context.getTenantRequired().tenantId;
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      actor.tenantId !== tenantId ||
      !actor.scopes.includes('erp:care:occasion:source:read')
    ) {
      throw new ForbiddenException({
        code: 'ORG_CARE_OCCASION_SOURCE_DENIED',
        message: '缺少关怀主数据读取权限',
      });
    }
    return tenantId;
  }

  private assertEmployeeReference(
    employee: Employee,
    employeeId: string,
    tenantId: string,
  ): void {
    if (
      employee.tenantId !== tenantId ||
      employee.id !== employeeId ||
      !['probation', 'active', 'suspended', 'terminated'].includes(employee.status)
    ) {
      throw this.sourceReferenceInvalid();
    }
  }

  private assertCurrentEmploymentReference(
    employment: Employment,
    employeeId: string,
    tenantId: string,
  ): void {
    if (
      employment.tenantId !== tenantId ||
      employment.employeeId !== employeeId ||
      employment.effectiveTo !== null ||
      !['probation', 'active', 'suspended'].includes(employment.status)
    ) {
      throw this.sourceReferenceInvalid();
    }
  }

  private assertPersonReference(
    person: Person,
    personId: string,
    tenantId: string,
  ): void {
    if (
      person.tenantId !== tenantId ||
      person.id !== personId ||
      person.status !== 'active'
    ) {
      throw this.sourceReferenceInvalid();
    }
  }

  private assertEmploymentHistories(
    histories: readonly Employment[],
    current: Employment,
    tenantId: string,
  ): void {
    const ids = new Set<string>();
    let matchingCurrent = 0;
    let openCount = 0;
    for (const employment of histories) {
      if (
        employment.tenantId !== tenantId ||
        employment.personId !== current.personId ||
        ids.has(employment.id) ||
        !['probation', 'active', 'suspended', 'resigned'].includes(employment.status) ||
        !this.isLocalDate(employment.effectiveFrom) ||
        (
          employment.effectiveTo !== null &&
          (
            !this.isLocalDate(employment.effectiveTo) ||
            employment.effectiveTo < employment.effectiveFrom
          )
        ) ||
        (
          employment.status === 'resigned' &&
          employment.effectiveTo === null
        ) ||
        (
          employment.status !== 'resigned' &&
          employment.effectiveTo !== null
        )
      ) {
        throw this.sourceReferenceInvalid();
      }
      ids.add(employment.id);
      if (employment.effectiveTo === null) openCount += 1;
      if (employment.id === current.id) {
        matchingCurrent += 1;
        if (
          employment.employeeId !== current.employeeId ||
          employment.status !== current.status ||
          employment.effectiveFrom !== current.effectiveFrom ||
          employment.effectiveTo !== current.effectiveTo
        ) {
          throw this.sourceReferenceInvalid();
        }
      }
    }
    if (matchingCurrent !== 1 || openCount !== 1) {
      throw this.sourceReferenceInvalid();
    }
  }

  private assertBirthdayProjection(
    person: Person,
    blindIndexes: readonly string[],
  ): void {
    const absent = (
      person.birthdayEvidenceId === null &&
      person.birthdayAttestedAt === null &&
      blindIndexes.length === 0
    );
    const attested = (
      person.birthdayEvidenceId !== null &&
      person.birthdayAttestedAt !== null &&
      this.isCanonicalInstant(person.birthdayAttestedAt) &&
      blindIndexes.length >= 1 &&
      blindIndexes.length <= 5 &&
      new Set(blindIndexes).size === blindIndexes.length
    );
    if (!absent && !attested) throw this.sourceReferenceInvalid();
  }

  private isLocalDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value;
  }

  private isCanonicalInstant(value: string): boolean {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  private sourceReferenceInvalid(): ConflictException {
    return new ConflictException({
      code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID',
      message: '关怀主数据来源引用不一致，必须人工复核',
    });
  }
}
