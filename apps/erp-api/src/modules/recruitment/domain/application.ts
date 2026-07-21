import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentCode,
  assertRecruitmentId,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

export type CandidateApplicationStage =
  | 'applied'
  | 'screening'
  | 'interview'
  | 'offer_approval'
  | 'offer_sent'
  | 'offer_accepted'
  | 'preboarding'
  | 'hired'
  | 'rejected'
  | 'withdrawn';

export interface CandidateApplication {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly positionId: string;
  readonly consentEvidenceId: string;
  readonly sourceChannel: string;
  readonly stage: CandidateApplicationStage;
  readonly completedInterviewId: string | null;
  readonly offerId: string | null;
  readonly acceptanceEvidenceId: string | null;
  readonly onboardingInstanceId: string | null;
  readonly employmentId: string | null;
  readonly version: number;
  readonly appliedAt: string;
  readonly endedAt: string | null;
  readonly updatedAt: string;
}

export interface CandidateApplicationStageEvent {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly from: CandidateApplicationStage;
  readonly to: CandidateApplicationStage;
  readonly actorId: string;
  readonly reasonCode: string | null;
  readonly evidenceId: string | null;
  readonly resultingVersion: number;
  readonly occurredAt: string;
}

export function createCandidateApplication(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly candidateId: string;
    readonly positionId: string;
    readonly consentEvidenceId: string;
    readonly sourceChannel: string;
  },
  now: Date,
): CandidateApplication {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    candidateId: input.candidateId,
    positionId: input.positionId,
    consentEvidenceId: input.consentEvidenceId,
  })) assertRecruitmentId(value, field);
  assertRecruitmentCode(input.sourceChannel, 'sourceChannel');
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...input,
    stage: 'applied' as const,
    completedInterviewId: null,
    offerId: null,
    acceptanceEvidenceId: null,
    onboardingInstanceId: null,
    employmentId: null,
    version: 1,
    appliedAt: occurredAt,
    endedAt: null,
    updatedAt: occurredAt,
  });
}

/** 单向推进申请阶段；跨聚合事实必须以受信任证据标识传入并固化。 */
export function transitionCandidateApplication(
  application: CandidateApplication,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly targetStage: Exclude<CandidateApplicationStage, 'applied'>;
    readonly reasonCode?: string;
    readonly evidenceId?: string;
  },
  now: Date,
): { readonly application: CandidateApplication; readonly event: CandidateApplicationStageEvent } {
  assertRecruitmentTenant(application.tenantId, input.tenantId);
  assertRecruitmentVersion(input.expectedVersion);
  assertRecruitmentId(input.actorId, 'actorId');
  if (application.version !== input.expectedVersion) {
    throw new RecruitmentDomainError('RECRUITMENT_VERSION_CONFLICT', '候选申请版本冲突');
  }
  const allowed = allowedTargets(application.stage);
  if (!allowed.includes(input.targetStage)) {
    throw new RecruitmentDomainError('CANDIDATE_STAGE_TRANSITION_INVALID', '候选申请阶段迁移无效');
  }
  const reasonCode = input.reasonCode === undefined ? null : validatedReason(input.reasonCode);
  if ((input.targetStage === 'rejected' || input.targetStage === 'withdrawn') && reasonCode === null) {
    throw new RecruitmentDomainError('CANDIDATE_STAGE_REASON_REQUIRED', '淘汰或退出必须提供原因码');
  }
  const requiredEvidence = evidenceRequired(input.targetStage);
  const evidenceId = input.evidenceId ?? null;
  if (requiredEvidence && evidenceId === null) {
    throw new RecruitmentDomainError('CANDIDATE_STAGE_EVIDENCE_REQUIRED', '目标阶段缺少受信任证据引用');
  }
  if (evidenceId !== null) assertRecruitmentId(evidenceId, 'evidenceId');
  const occurredAt = toRecruitmentIso(now);
  const terminal = ['hired', 'rejected', 'withdrawn'].includes(input.targetStage);
  const next = deepFreezeRecruitment({
    ...application,
    stage: input.targetStage,
    completedInterviewId: input.targetStage === 'offer_approval'
      ? evidenceId
      : application.completedInterviewId,
    offerId: input.targetStage === 'offer_sent' ? evidenceId : application.offerId,
    acceptanceEvidenceId: input.targetStage === 'offer_accepted'
      ? evidenceId
      : application.acceptanceEvidenceId,
    onboardingInstanceId: input.targetStage === 'preboarding'
      ? evidenceId
      : application.onboardingInstanceId,
    employmentId: input.targetStage === 'hired' ? evidenceId : application.employmentId,
    version: application.version + 1,
    endedAt: terminal ? occurredAt : null,
    updatedAt: occurredAt,
  });
  return Object.freeze({
    application: next,
    event: deepFreezeRecruitment({
      applicationId: application.id,
      tenantId: application.tenantId,
      from: application.stage,
      to: input.targetStage,
      actorId: input.actorId,
      reasonCode,
      evidenceId,
      resultingVersion: next.version,
      occurredAt,
    }),
  });
}

function allowedTargets(stage: CandidateApplicationStage): readonly CandidateApplicationStage[] {
  const commonExit: readonly CandidateApplicationStage[] = ['rejected', 'withdrawn'];
  const transitions: Readonly<Record<CandidateApplicationStage, readonly CandidateApplicationStage[]>> = {
    applied: ['screening', ...commonExit],
    screening: ['interview', ...commonExit],
    interview: ['offer_approval', ...commonExit],
    offer_approval: ['offer_sent', ...commonExit],
    offer_sent: ['offer_accepted', ...commonExit],
    offer_accepted: ['preboarding', 'withdrawn'],
    preboarding: ['hired', 'withdrawn'],
    hired: [],
    rejected: [],
    withdrawn: [],
  };
  return transitions[stage];
}

function evidenceRequired(stage: CandidateApplicationStage): boolean {
  return ['offer_approval', 'offer_sent', 'offer_accepted', 'preboarding', 'hired'].includes(stage);
}

function validatedReason(value: string): string {
  assertRecruitmentCode(value, 'reasonCode');
  return value;
}
