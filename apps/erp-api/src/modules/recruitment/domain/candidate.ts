import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentCode,
  assertRecruitmentId,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export interface CandidateConsent {
  readonly evidenceId: string;
  readonly version: string;
  readonly purpose: string;
  readonly source: 'portal' | 'channel' | 'manual_import';
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly withdrawnAt: string | null;
}

export interface Candidate {
  readonly id: string;
  readonly tenantId: string;
  readonly status: 'active' | 'consent_withdrawn' | 'anonymized';
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly consent: CandidateConsent;
  readonly retentionExpiresAt: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建与职位无关的候选人主档；精确字段在进入仓储前必须加密和生成盲索引。 */
export function createCandidate(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
    readonly phone?: string;
    readonly email?: string;
    readonly consentEvidenceId: string;
    readonly consentVersion: string;
    readonly consentPurpose: string;
    readonly consentSource: CandidateConsent['source'];
    readonly consentExpiresAt: Date;
    readonly retentionExpiresAt: Date;
  },
  now: Date,
): Candidate {
  assertRecruitmentId(input.id, 'id');
  assertRecruitmentId(input.tenantId, 'tenantId');
  assertRecruitmentId(input.consentEvidenceId, 'consentEvidenceId');
  assertRecruitmentCode(input.consentVersion, 'consentVersion');
  const name = input.name.normalize('NFKC').trim();
  if (name.length < 1 || name.length > 128) {
    throw new RecruitmentDomainError('CANDIDATE_NAME_INVALID', '候选人姓名长度必须为 1..128');
  }
  const phone = input.phone === undefined ? null : normalizeCandidatePhone(input.phone);
  const email = input.email === undefined ? null : normalizeCandidateEmail(input.email);
  if (phone === null && email === null) {
    throw new RecruitmentDomainError('CANDIDATE_CONTACT_REQUIRED', '手机号和邮箱至少提供一项');
  }
  const occurredAt = toRecruitmentIso(now);
  const consentExpiresAt = toRecruitmentIso(input.consentExpiresAt);
  const retentionExpiresAt = toRecruitmentIso(input.retentionExpiresAt);
  if (input.consentExpiresAt <= now || input.retentionExpiresAt <= now) {
    throw new RecruitmentDomainError('CANDIDATE_RETENTION_INVALID', '授权和保留期必须晚于当前时间');
  }
  const purpose = input.consentPurpose.normalize('NFKC').trim();
  if (purpose.length < 3 || purpose.length > 256) {
    throw new RecruitmentDomainError('CANDIDATE_CONSENT_PURPOSE_INVALID', '授权目的长度必须为 3..256');
  }
  return deepFreezeRecruitment({
    id: input.id,
    tenantId: input.tenantId,
    status: 'active' as const,
    name,
    phone,
    email,
    consent: {
      evidenceId: input.consentEvidenceId,
      version: input.consentVersion,
      purpose,
      source: input.consentSource,
      capturedAt: occurredAt,
      expiresAt: consentExpiresAt,
      withdrawnAt: null,
    },
    retentionExpiresAt,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 撤回非必要处理授权；依法保留的数据由生命周期任务另行匿名化。 */
export function withdrawCandidateConsent(
  candidate: Candidate,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): Candidate {
  assertCandidateCommand(candidate, input.tenantId, input.expectedVersion);
  if (candidate.status !== 'active') {
    throw new RecruitmentDomainError('CANDIDATE_CONSENT_ALREADY_WITHDRAWN', '候选人授权已撤回或已匿名化');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...candidate,
    status: 'consent_withdrawn' as const,
    consent: { ...candidate.consent, withdrawnAt: occurredAt },
    version: candidate.version + 1,
    updatedAt: occurredAt,
  });
}

/** 记录再次授权并更新当前有效快照；历史授权由追加证据集合保留。 */
export function grantCandidateConsent(
  candidate: Candidate,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly evidenceId: string;
    readonly consentVersion: string;
    readonly purpose: string;
    readonly source: CandidateConsent['source'];
    readonly expiresAt: Date;
    readonly retentionExpiresAt: Date;
  },
  now: Date,
): Candidate {
  assertCandidateCommand(candidate, input.tenantId, input.expectedVersion);
  if (candidate.status === 'anonymized') {
    throw new RecruitmentDomainError('CANDIDATE_ANONYMIZED', '匿名候选人不能恢复直接身份数据');
  }
  assertRecruitmentId(input.evidenceId, 'evidenceId');
  assertRecruitmentCode(input.consentVersion, 'consentVersion');
  const purpose = input.purpose.normalize('NFKC').trim();
  if (
    purpose.length < 3 || purpose.length > 256 || input.expiresAt <= now ||
    input.retentionExpiresAt <= now
  ) {
    throw new RecruitmentDomainError('CANDIDATE_CONSENT_INVALID', '候选人授权目的或有效期无效');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...candidate,
    status: 'active' as const,
    consent: {
      evidenceId: input.evidenceId,
      version: input.consentVersion,
      purpose,
      source: input.source,
      capturedAt: occurredAt,
      expiresAt: toRecruitmentIso(input.expiresAt),
      withdrawnAt: null,
    },
    retentionExpiresAt: toRecruitmentIso(input.retentionExpiresAt),
    version: candidate.version + 1,
    updatedAt: occurredAt,
  });
}

/** 到期匿名化删除直接身份字段，但保留无个人原文的流程统计引用。 */
export function anonymizeCandidate(
  candidate: Candidate,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): Candidate {
  assertCandidateCommand(candidate, input.tenantId, input.expectedVersion);
  if (candidate.status === 'anonymized') {
    throw new RecruitmentDomainError('CANDIDATE_ALREADY_ANONYMIZED', '候选人已匿名化');
  }
  if (candidate.status !== 'consent_withdrawn' && now < new Date(candidate.retentionExpiresAt)) {
    throw new RecruitmentDomainError('CANDIDATE_RETENTION_ACTIVE', '候选人仍在有效授权或法定保留期内');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...candidate,
    status: 'anonymized' as const,
    name: null,
    phone: null,
    email: null,
    version: candidate.version + 1,
    updatedAt: occurredAt,
  });
}

export function normalizeCandidatePhone(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\s()-]/gu, '');
  if (!E164_PATTERN.test(normalized)) {
    throw new RecruitmentDomainError('CANDIDATE_PHONE_INVALID', '手机号必须使用 E.164 格式');
  }
  return normalized;
}

export function normalizeCandidateEmail(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new RecruitmentDomainError('CANDIDATE_EMAIL_INVALID', '邮箱格式无效');
  }
  return normalized;
}

function assertCandidateCommand(
  candidate: Candidate,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentId(tenantId, 'tenantId');
  assertRecruitmentTenant(candidate.tenantId, tenantId);
  assertRecruitmentVersion(expectedVersion);
  if (candidate.version !== expectedVersion) {
    throw new RecruitmentDomainError('RECRUITMENT_VERSION_CONFLICT', '候选人版本冲突');
  }
}
