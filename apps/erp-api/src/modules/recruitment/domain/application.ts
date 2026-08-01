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

export type CandidateApplicationBaselineStage =
  | 'applied'
  | 'screening'
  | 'interview'
  | 'rejected'
  | 'withdrawn';

export interface CandidateApplicationBaselineAction {
  readonly targetStage: Exclude<CandidateApplicationBaselineStage, 'applied'>;
  readonly reasonCode: string | null;
  readonly occurredAt: string;
}

export interface CandidateApplicationOfferMigrationAction {
  readonly targetStage: 'offer_approval' | 'offer_sent' | 'offer_accepted' | 'rejected' | 'withdrawn';
  readonly evidenceId: string;
  readonly reasonCode: string | null;
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

/** 数据迁移专用：以内存状态机验证申请基线，不伪造在线普通阶段事件。 */
export function restoreCandidateApplicationBaselineFromMigration(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly candidateId: string;
    readonly positionId: string;
    readonly consentEvidenceId: string;
    readonly sourceChannel: string;
    readonly actorId: string;
    readonly actions: readonly CandidateApplicationBaselineAction[];
    readonly expectedStage: CandidateApplicationBaselineStage;
    readonly expectedVersion: number;
    readonly appliedAt: string;
    readonly endedAt: string | null;
    readonly updatedAt: string;
  },
  now: Date,
): CandidateApplication {
  if (input.actions.length > 20 || input.expectedVersion !== input.actions.length + 1) {
    throw new RecruitmentDomainError(
      'CANDIDATE_MIGRATION_APPLICATION_TIMELINE_INVALID',
      '申请迁移动作数量与版本不一致',
    );
  }
  const appliedAt = strictApplicationMigrationIso(input.appliedAt);
  const updatedAt = strictApplicationMigrationIso(input.updatedAt);
  const endedAt = input.endedAt === null ? null : strictApplicationMigrationIso(input.endedAt);
  if (Date.parse(appliedAt) > now.getTime() + 5 * 60 * 1_000) throw new RecruitmentDomainError(
    'CANDIDATE_MIGRATION_APPLICATION_TIMELINE_INVALID',
    '申请时间不能位于未来',
  );
  let application = createCandidateApplication({
    id: input.id,
    tenantId: input.tenantId,
    candidateId: input.candidateId,
    positionId: input.positionId,
    consentEvidenceId: input.consentEvidenceId,
    sourceChannel: input.sourceChannel,
  }, new Date(appliedAt));
  let previous = appliedAt;
  for (const action of input.actions) {
    const occurredAt = strictApplicationMigrationIso(action.occurredAt);
    if (occurredAt < previous || Date.parse(occurredAt) > now.getTime() + 5 * 60 * 1_000) {
      throw new RecruitmentDomainError(
        'CANDIDATE_MIGRATION_APPLICATION_TIMELINE_INVALID',
        '申请迁移动作必须按时间排序且不能位于未来',
      );
    }
    application = transitionCandidateApplication(application, {
      tenantId: input.tenantId,
      expectedVersion: application.version,
      actorId: input.actorId,
      targetStage: action.targetStage,
      ...(action.reasonCode === null ? {} : { reasonCode: action.reasonCode }),
    }, new Date(occurredAt)).application;
    previous = occurredAt;
  }
  if (application.stage !== input.expectedStage || application.version !== input.expectedVersion ||
    application.updatedAt !== updatedAt || application.endedAt !== endedAt) {
    throw new RecruitmentDomainError(
      'CANDIDATE_MIGRATION_APPLICATION_CONTROL_MISMATCH',
      '申请迁移最终阶段、版本或时间控制事实不一致',
    );
  }
  return application;
}

/** Offer 迁移专用：从已冻结面试基线回放后续申请阶段，不写普通阶段日志。 */
export function restoreCandidateApplicationOfferStagesFromMigration(
  baseline: CandidateApplication,
  input: {
    readonly actorId: string;
    readonly actions: readonly CandidateApplicationOfferMigrationAction[];
    readonly expectedStage: CandidateApplicationStage;
    readonly expectedVersion: number;
    readonly endedAt: string | null;
    readonly updatedAt: string;
  },
  now: Date,
): CandidateApplication {
  const baselineUpdatedAt = strictApplicationMigrationIso(baseline.updatedAt);
  if (baseline.stage !== 'interview' || input.actions.length > 5 ||
    input.expectedVersion !== baseline.version + input.actions.length) {
    throw new RecruitmentDomainError(
      'CANDIDATE_MIGRATION_OFFER_TIMELINE_INVALID', 'Offer 迁移申请基线或版本无效',
    );
  }
  let application = baseline;
  let previous = baselineUpdatedAt;
  for (const action of input.actions) {
    const occurredAt = strictApplicationMigrationIso(action.occurredAt);
    if (occurredAt < previous || Date.parse(occurredAt) > now.getTime() + 5 * 60 * 1_000) {
      throw new RecruitmentDomainError(
        'CANDIDATE_MIGRATION_OFFER_TIMELINE_INVALID', 'Offer 申请动作必须按时间排序且不能位于未来',
      );
    }
    application = transitionCandidateApplication(application, {
      tenantId: baseline.tenantId,
      expectedVersion: application.version,
      actorId: input.actorId,
      targetStage: action.targetStage,
      evidenceId: action.evidenceId,
      ...(action.reasonCode === null ? {} : { reasonCode: action.reasonCode }),
    }, new Date(occurredAt)).application;
    previous = occurredAt;
  }
  const endedAt = input.endedAt === null ? null : strictApplicationMigrationIso(input.endedAt);
  const updatedAt = strictApplicationMigrationIso(input.updatedAt);
  if (application.stage !== input.expectedStage || application.version !== input.expectedVersion ||
    application.endedAt !== endedAt || application.updatedAt !== updatedAt) {
    throw new RecruitmentDomainError(
      'CANDIDATE_MIGRATION_OFFER_CONTROL_MISMATCH',
      'Offer 迁移申请最终阶段、版本或时间控制事实不一致',
    );
  }
  return application;
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
    readonly employmentId?: string;
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
  const employmentId = input.employmentId ?? null;
  if (input.targetStage === 'hired' && employmentId === null) {
    throw new RecruitmentDomainError(
      'CANDIDATE_STAGE_EMPLOYMENT_REQUIRED',
      '已入职阶段必须绑定劳动关系',
    );
  }
  if (input.targetStage !== 'hired' && employmentId !== null) {
    throw new RecruitmentDomainError(
      'CANDIDATE_STAGE_EMPLOYMENT_UNEXPECTED',
      '非入职阶段禁止绑定劳动关系',
    );
  }
  if (employmentId !== null) assertRecruitmentId(employmentId, 'employmentId');
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
    employmentId: input.targetStage === 'hired' ? employmentId : application.employmentId,
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

function strictApplicationMigrationIso(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'CANDIDATE_MIGRATION_APPLICATION_TIME_INVALID',
      '申请迁移时间必须为规范 UTC ISO 时间',
    );
  }
  return value;
}
