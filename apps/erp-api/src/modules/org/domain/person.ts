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
    status: 'active',
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
