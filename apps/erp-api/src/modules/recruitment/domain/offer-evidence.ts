import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentId,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type RecruitmentOfferEvidenceKind = 'sent' | 'accepted' | 'declined';

/** Offer 外部事实的不可变摘要；原始回执保留在 Integration/门户证据库。 */
export interface RecruitmentOfferEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly offerId: string;
  readonly kind: RecruitmentOfferEvidenceKind;
  readonly category: 'delivery' | 'candidate_decision';
  readonly source: 'integration_delivery' | 'candidate_portal';
  readonly subjectCandidateId: string | null;
  readonly sendRequestId: string | null;
  readonly authenticationEvidenceId: string | null;
  readonly proofHash: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly recordedAt: string;
}

export function createRecruitmentOfferEvidence(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly offerId: string;
    readonly kind: RecruitmentOfferEvidenceKind;
    readonly subjectCandidateId?: string;
    readonly sendRequestId?: string;
    readonly authenticationEvidenceId?: string;
    readonly proofHash: string;
    readonly occurredAt: Date;
    readonly actorId: string;
  },
  now: Date,
): RecruitmentOfferEvidence {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, offerId: input.offerId, actorId: input.actorId,
  })) assertRecruitmentId(value, field);
  if (!SHA256_BASE64URL_PATTERN.test(input.proofHash)) throw new RecruitmentDomainError(
    'RECRUITMENT_OFFER_EVIDENCE_HASH_INVALID', 'Offer 证据必须使用 SHA-256 base64url 摘要',
  );
  const occurredAt = toRecruitmentIso(input.occurredAt);
  const recordedAt = toRecruitmentIso(now);
  if (input.occurredAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_OFFER_EVIDENCE_TIME_INVALID', 'Offer 证据时间超出允许时钟偏差',
    );
  }
  const sent = input.kind === 'sent';
  const decision = input.kind === 'accepted' || input.kind === 'declined';
  if (sent) {
    if (input.sendRequestId === undefined) throw evidenceShapeInvalid();
    assertRecruitmentId(input.sendRequestId, 'sendRequestId');
    if (input.subjectCandidateId !== undefined || input.authenticationEvidenceId !== undefined) {
      throw evidenceShapeInvalid();
    }
  }
  if (decision) {
    if (input.subjectCandidateId === undefined || input.authenticationEvidenceId === undefined) {
      throw evidenceShapeInvalid();
    }
    assertRecruitmentId(input.subjectCandidateId, 'subjectCandidateId');
    assertRecruitmentId(input.authenticationEvidenceId, 'authenticationEvidenceId');
    if (input.sendRequestId !== undefined) throw evidenceShapeInvalid();
  }
  return deepFreezeRecruitment({
    id: input.id,
    tenantId: input.tenantId,
    offerId: input.offerId,
    kind: input.kind,
    category: sent ? 'delivery' as const : 'candidate_decision' as const,
    source: sent ? 'integration_delivery' as const : 'candidate_portal' as const,
    subjectCandidateId: input.subjectCandidateId ?? null,
    sendRequestId: input.sendRequestId ?? null,
    authenticationEvidenceId: input.authenticationEvidenceId ?? null,
    proofHash: input.proofHash,
    occurredAt,
    actorId: input.actorId,
    recordedAt,
  });
}

function evidenceShapeInvalid(): RecruitmentDomainError {
  return new RecruitmentDomainError(
    'RECRUITMENT_OFFER_EVIDENCE_SHAPE_INVALID', 'Offer 证据类型与来源字段不一致',
  );
}
