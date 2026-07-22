import { OrgDomainError } from './org.errors.js';
import { assertEntityId, assertTenantId, toIso } from './org.validation.js';

export type EmploymentStatus = 'probation' | 'active' | 'suspended' | 'resigned';

const EMPLOYMENT_STATUS_TRANSITIONS: Readonly<Record<EmploymentStatus, readonly EmploymentStatus[]>> = {
  probation: ['active'], active: ['suspended'], suspended: ['active'], resigned: [],
};

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
  readonly terminationCareCaseId: string | null;
  readonly terminationExecutionEvidenceId: string | null;
  readonly terminationEvidenceId: string | null;
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
  readonly effectiveFrom: string;
}

export interface RestoreEmploymentFromMigrationInput extends CreateEmploymentInput {
  readonly status: EmploymentStatus;
  readonly effectiveTo: string | null;
  readonly terminationCareCaseId: string | null;
  readonly terminationExecutionEvidenceId: string | null;
  readonly terminationEvidenceId: string | null;
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
  const effectiveFrom = assertLocalDate(input.effectiveFrom, 'effectiveFrom');
  const occurredAt = toIso(now);
  const effectiveTime = Date.parse(`${effectiveFrom}T00:00:00.000Z`);
  const currentDateTime = Date.parse(`${occurredAt.slice(0, 10)}T00:00:00.000Z`);
  if (effectiveTime < currentDateTime - 366 * 24 * 60 * 60 * 1000) {
    throw new OrgDomainError('EMPLOYMENT_EFFECTIVE_DATE_INVALID', '劳动关系生效日期超出允许补录范围');
  }
  if (effectiveTime > currentDateTime + 730 * 24 * 60 * 60 * 1000) {
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
    terminationCareCaseId: null,
    terminationExecutionEvidenceId: null,
    terminationEvidenceId: null,
    status: 'probation',
    effectiveFrom,
    effectiveTo: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/**
 * 数据迁移专用：从完整证据快照恢复劳动关系，不执行入职或离职副作用。
 * 已离职记录必须携带完整终止证据；开放记录禁止夹带终止字段。
 */
export function restoreEmploymentFromMigration(
  input: RestoreEmploymentFromMigrationInput,
  now: Date,
): Employment {
  assertTenantId(input.tenantId);
  if (!['probation', 'active', 'suspended', 'resigned'].includes(input.status)) {
    throw new OrgDomainError('INVALID_STATUS', '劳动关系状态非法');
  }
  for (const [field, value] of Object.entries({
    id: input.id,
    personId: input.personId,
    employeeId: input.employeeId,
    onboardingInstanceId: input.onboardingInstanceId,
    onboardingCompletionEvidenceId: input.onboardingCompletionEvidenceId,
    offerId: input.offerId,
    signedEvidenceId: input.signedEvidenceId,
  })) assertEntityId(value, field);
  const effectiveFrom = assertLocalDate(input.effectiveFrom, 'effectiveFrom');
  const terminationValues = [
    input.terminationCareCaseId,
    input.terminationExecutionEvidenceId,
    input.terminationEvidenceId,
  ];
  if (input.status === 'resigned') {
    if (input.effectiveTo === null || terminationValues.some((value) => value === null)) {
      throw new OrgDomainError(
        'EMPLOYMENT_MIGRATION_TERMINATION_EVIDENCE_REQUIRED',
        '已离职劳动关系必须包含结束日期与完整终止证据',
      );
    }
  } else if (input.effectiveTo !== null || terminationValues.some((value) => value !== null)) {
    throw new OrgDomainError(
      'EMPLOYMENT_MIGRATION_OPEN_STATE_INVALID',
      '开放劳动关系不能包含结束日期或终止证据',
    );
  }
  for (const [field, value] of Object.entries({
    terminationCareCaseId: input.terminationCareCaseId,
    terminationExecutionEvidenceId: input.terminationExecutionEvidenceId,
    terminationEvidenceId: input.terminationEvidenceId,
  })) {
    if (value !== null) assertEntityId(value, field);
  }
  const effectiveTo = input.effectiveTo === null
    ? null
    : assertLocalDate(input.effectiveTo, 'effectiveTo');
  if (effectiveTo !== null && effectiveTo < effectiveFrom) throw new OrgDomainError(
    'EMPLOYMENT_END_BEFORE_START', '劳动关系结束日期不能早于生效日期',
  );
  const occurredAt = toIso(now);
  return Object.freeze({
    ...input,
    effectiveFrom,
    effectiveTo,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** Care 专用：关闭劳动关系；业务日期、案件和执行证据一经写入不可替换。 */
export function terminateEmployment(
  employment: Employment,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly effectiveTo: string;
    readonly careCaseId: string;
    readonly executionEvidenceId: string;
    readonly terminationEvidenceId: string;
  },
  now: Date,
): Employment {
  assertTenantId(input.tenantId);
  if (employment.tenantId !== input.tenantId) throw new OrgDomainError(
    'EMPLOYMENT_CROSS_TENANT', '禁止跨租户关闭劳动关系',
  );
  if (employment.version !== input.expectedVersion) throw new OrgDomainError(
    'EMPLOYMENT_VERSION_CONFLICT', '劳动关系版本冲突',
  );
  if (employment.status === 'resigned' || employment.effectiveTo !== null) throw new OrgDomainError(
    'EMPLOYMENT_ALREADY_TERMINATED', '劳动关系已经关闭',
  );
  for (const [field, value] of Object.entries({
    careCaseId: input.careCaseId,
    executionEvidenceId: input.executionEvidenceId,
    terminationEvidenceId: input.terminationEvidenceId,
  })) assertEntityId(value, field);
  const effectiveTo = assertLocalDate(input.effectiveTo, 'effectiveTo');
  if (effectiveTo < employment.effectiveFrom) throw new OrgDomainError(
    'EMPLOYMENT_END_BEFORE_START', '劳动关系结束日期不能早于生效日期',
  );
  return Object.freeze({
    ...employment, status: 'resigned', effectiveTo,
    terminationCareCaseId: input.careCaseId,
    terminationExecutionEvidenceId: input.executionEvidenceId,
    terminationEvidenceId: input.terminationEvidenceId,
    version: employment.version + 1, updatedAt: toIso(now),
  });
}

/** Employee 组织状态迁移时同步当前劳动关系；离职只能走 terminateEmployment。 */
export function transitionEmploymentStatus(
  employment: Employment,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly status: 'active' | 'suspended';
  },
  now: Date,
): Employment {
  assertTenantId(input.tenantId);
  if (employment.tenantId !== input.tenantId) throw new OrgDomainError(
    'EMPLOYMENT_CROSS_TENANT', '禁止跨租户迁移劳动关系状态',
  );
  if (employment.version !== input.expectedVersion) throw new OrgDomainError(
    'EMPLOYMENT_VERSION_CONFLICT', '劳动关系版本冲突',
  );
  if (!EMPLOYMENT_STATUS_TRANSITIONS[employment.status].includes(input.status)) {
    throw new OrgDomainError('EMPLOYMENT_STATUS_TRANSITION_INVALID', '劳动关系状态迁移非法');
  }
  return Object.freeze({
    ...employment, status: input.status, version: employment.version + 1, updatedAt: toIso(now),
  });
}

function assertLocalDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new OrgDomainError('EMPLOYMENT_EFFECTIVE_DATE_INVALID', `${field} 必须为 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new OrgDomainError('EMPLOYMENT_EFFECTIVE_DATE_INVALID', `${field} 不是合法日期`);
  }
  return value;
}
