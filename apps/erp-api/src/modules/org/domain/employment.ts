import { OrgDomainError } from './org.errors.js';
import { assertEntityId, assertTenantId, toIso } from './org.validation.js';

export type EmploymentStatus = 'probation' | 'active' | 'suspended' | 'resigned';

/** 劳动关系聚合；合同正文和薪资不进入组织主数据。 */
export interface Employment {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly employeeId: string;
  readonly onboardingInstanceId: string;
  readonly onboardingCompletionEvidenceId: string;
  readonly offerId: string;
  readonly signedEvidenceId: string;
  readonly status: EmploymentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateEmploymentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly employeeId: string;
  readonly onboardingInstanceId: string;
  readonly onboardingCompletionEvidenceId: string;
  readonly offerId: string;
  readonly signedEvidenceId: string;
  readonly effectiveFrom: Date;
}

/** 建立候选人入职产生的劳动关系，默认进入试用期。 */
export function createEmployment(input: CreateEmploymentInput, now: Date): Employment {
  assertTenantId(input.tenantId);
  for (const [field, value] of Object.entries({
    id: input.id,
    personId: input.personId,
    employeeId: input.employeeId,
    onboardingInstanceId: input.onboardingInstanceId,
    onboardingCompletionEvidenceId: input.onboardingCompletionEvidenceId,
    offerId: input.offerId,
    signedEvidenceId: input.signedEvidenceId,
  })) assertEntityId(value, field);
  const effectiveFrom = toIso(input.effectiveFrom);
  const occurredAt = toIso(now);
  if (Date.parse(effectiveFrom) < Date.parse(occurredAt) - 366 * 24 * 60 * 60 * 1000) {
    throw new OrgDomainError('EMPLOYMENT_EFFECTIVE_DATE_INVALID', '劳动关系生效日期超出允许补录范围');
  }
  if (Date.parse(effectiveFrom) > Date.parse(occurredAt) + 730 * 24 * 60 * 60 * 1000) {
    throw new OrgDomainError('EMPLOYMENT_EFFECTIVE_DATE_INVALID', '劳动关系生效日期超出允许预建范围');
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    personId: input.personId,
    employeeId: input.employeeId,
    onboardingInstanceId: input.onboardingInstanceId,
    onboardingCompletionEvidenceId: input.onboardingCompletionEvidenceId,
    offerId: input.offerId,
    signedEvidenceId: input.signedEvidenceId,
    status: 'probation',
    effectiveFrom,
    effectiveTo: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
