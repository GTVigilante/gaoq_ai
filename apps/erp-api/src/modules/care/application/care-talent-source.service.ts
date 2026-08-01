import { ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AlumniConsent,
  CareCaseStatus,
  CareTaskCode,
  SeparationType,
} from '../domain/index.js';
import { careTaskStatuses } from '../domain/index.js';
import {
  CareAlumniConsentRepository,
  CareCaseRepository,
} from '../persistence/care.repositories.js';

export interface CareTalentCase {
  readonly id: string;
  readonly employmentId: string;
  readonly employeeId: string;
  readonly separationType: SeparationType;
  readonly lastWorkingDate: string;
  readonly status: CareCaseStatus;
  readonly tasks: Readonly<Record<CareTaskCode, 'pending' | 'completed'>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CareTalentConsent {
  readonly id: string;
  readonly personId: string;
  readonly careCaseId: string;
  readonly purpose: AlumniConsent['purpose'];
  readonly channels: AlumniConsent['channels'];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly withdrawnAt: string | null;
  readonly status: AlumniConsent['status'];
}

export interface CareTalentSnapshot {
  readonly cases: readonly CareTalentCase[];
  readonly alumniConsents: readonly CareTalentConsent[];
}

export interface CareTalentQuery {
  readonly personId: string | null;
  readonly employments: readonly {
    readonly id: string;
    readonly employeeId: string;
  }[];
}

/** 人才全景的 Care 窄查询口；原因编码和证据标识不进入跨域视图。 */
@Injectable()
export class CareTalentSourceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly cases: CareCaseRepository,
    private readonly consents: CareAlumniConsentRepository,
  ) {}

  async getByEmployments(input: CareTalentQuery): Promise<CareTalentSnapshot> {
    this.assertScope();
    const tenantId = this.context.getTenantRequired().tenantId;
    const employmentById = new Map(input.employments.map((employment) => [
      employment.id,
      employment,
    ]));
    const cases = await this.cases.findByEmploymentIds([...employmentById.keys()]);
    if (cases.some((careCase) => {
      const employment = employmentById.get(careCase.employmentId);
      return (
        careCase.tenantId !== tenantId ||
        employment === undefined ||
        careCase.employeeId !== employment.employeeId
      );
    })) {
      throw new Error('TALENT_LIFECYCLE_CARE_CASE_REFERENCE_INVALID');
    }
    const consents = await this.consents.findByCareCaseIds(cases.map((careCase) => careCase.id));
    const careCaseIds = new Set(cases.map((careCase) => careCase.id));
    if (consents.some((consent) =>
      consent.tenantId !== tenantId ||
      !careCaseIds.has(consent.careCaseId) ||
      input.personId === null ||
      consent.personId !== input.personId
    )) {
      throw new Error('TALENT_LIFECYCLE_ALUMNI_CONSENT_REFERENCE_INVALID');
    }
    return Object.freeze({
      cases: Object.freeze(cases.map((careCase) => Object.freeze({
        id: careCase.id,
        employmentId: careCase.employmentId,
        employeeId: careCase.employeeId,
        separationType: careCase.separationType,
        lastWorkingDate: careCase.lastWorkingDate,
        status: careCase.status,
        tasks: careTaskStatuses(careCase),
        createdAt: careCase.createdAt,
        updatedAt: careCase.updatedAt,
      }))),
      alumniConsents: Object.freeze(consents.map((consent) => Object.freeze({
        id: consent.id,
        personId: consent.personId,
        careCaseId: consent.careCaseId,
        purpose: consent.purpose,
        channels: consent.channels,
        grantedAt: consent.grantedAt,
        expiresAt: consent.expiresAt,
        withdrawnAt: consent.withdrawnAt,
        status: consent.status,
      }))),
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
