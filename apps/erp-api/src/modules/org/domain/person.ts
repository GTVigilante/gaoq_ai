import { OrgDomainError } from './org.errors.js';
import { assertEntityId, assertTenantId, toIso } from './org.validation.js';

/** 自然人主数据；不保存证件号码、联系方式或候选人材料原文。 */
export interface Person {
  readonly id: string;
  readonly tenantId: string;
  /** 招聘候选人来源引用，仅用于幂等归并。 */
  readonly sourceCandidateId: string;
  /** 可信身份核验产生的不可变证据引用。 */
  readonly identityEvidenceId: string;
  /** 生日月日已由身份工作流证明；ERP 仅保存证据引用和不可逆盲索引。 */
  readonly birthdayEvidenceId: string | null;
  readonly birthdayAttestedAt: string | null;
  readonly status: 'active';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePersonInput {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceCandidateId: string;
  readonly identityEvidenceId: string;
}

/** 创建自然人主数据，原始证件材料必须留在受控证据存储而非组织主数据。 */
export function createPerson(input: CreatePersonInput, now: Date): Person {
  assertTenantId(input.tenantId);
  assertEntityId(input.id, 'id');
  assertEntityId(input.sourceCandidateId, 'sourceCandidateId');
  assertEntityId(input.identityEvidenceId, 'identityEvidenceId');
  if (input.sourceCandidateId === input.identityEvidenceId) {
    throw new OrgDomainError('PERSON_EVIDENCE_INVALID', '身份核验证据不能复用候选人标识');
  }
  const occurredAt = toIso(now);
  return Object.freeze({
    ...input,
    birthdayEvidenceId: null,
    birthdayAttestedAt: null,
    status: 'active',
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/**
 * 受信任身份工作流登记生日月日证明。
 * 月日本身不得进入 Person 聚合、事件或审计，由持久层仅保存独立 HMAC 盲索引。
 */
export function attestPersonBirthday(
  person: Person,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly identityEvidenceId: string;
    readonly birthdayEvidenceId: string;
  },
  now: Date,
): Person {
  assertTenantId(input.tenantId);
  if (person.tenantId !== input.tenantId) {
    throw new OrgDomainError('PERSON_CROSS_TENANT', '禁止跨租户登记自然人生日证明');
  }
  if (person.version !== input.expectedVersion) {
    throw new OrgDomainError('PERSON_VERSION_CONFLICT', '自然人主数据版本冲突');
  }
  assertEntityId(input.identityEvidenceId, 'identityEvidenceId');
  assertEntityId(input.birthdayEvidenceId, 'birthdayEvidenceId');
  if (person.identityEvidenceId !== input.identityEvidenceId) {
    throw new OrgDomainError('PERSON_IDENTITY_EVIDENCE_MISMATCH', '生日证明未绑定当前身份核验证据');
  }
  if (
    person.birthdayEvidenceId !== null &&
    person.birthdayEvidenceId !== input.birthdayEvidenceId
  ) {
    throw new OrgDomainError('PERSON_BIRTHDAY_IMMUTABLE', '生日证明已经登记且不可替换');
  }
  if (person.birthdayEvidenceId === input.birthdayEvidenceId) return person;
  return Object.freeze({
    ...person,
    birthdayEvidenceId: input.birthdayEvidenceId,
    birthdayAttestedAt: toIso(now),
    version: person.version + 1,
    updatedAt: toIso(now),
  });
}
