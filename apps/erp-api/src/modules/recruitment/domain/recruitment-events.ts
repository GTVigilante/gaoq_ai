import type { CandidateApplication, CandidateApplicationStageEvent } from './application.js';

export interface RecruitmentDomainEvent {
  readonly type: 'recruitment.application.created' | 'recruitment.application.stage_changed';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, string | number | null>>;
}

/** 申请创建事件仅携带领域标识，不复制候选人身份字段。 */
export function buildCandidateApplicationCreatedEvent(
  application: CandidateApplication,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.application.created',
    tenantId: application.tenantId,
    aggregateId: application.id,
    version: application.version,
    occurredAt: application.appliedAt,
    payload: Object.freeze({
      candidateId: application.candidateId,
      positionId: application.positionId,
      sourceChannel: application.sourceChannel,
      stage: application.stage,
    }),
  });
}

/** 阶段变化事件引用证据标识，不携带面试评价、Offer 条款或个人原文。 */
export function buildCandidateApplicationStageEvent(
  event: CandidateApplicationStageEvent,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.application.stage_changed',
    tenantId: event.tenantId,
    aggregateId: event.applicationId,
    version: event.resultingVersion,
    occurredAt: event.occurredAt,
    payload: Object.freeze({
      from: event.from,
      to: event.to,
      actorId: event.actorId,
      reasonCode: event.reasonCode,
      evidenceId: event.evidenceId,
    }),
  });
}
