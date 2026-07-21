import type { CandidateApplication, CandidateApplicationStageEvent } from './application.js';
import type { RecruitmentPosition } from './position.js';
import type { RecruitmentRequisition } from './requisition.js';

export type RecruitmentEventType =
  | 'recruitment.application.created'
  | 'recruitment.application.stage_changed'
  | 'recruitment.requisition.created'
  | 'recruitment.requisition.submitted'
  | 'recruitment.requisition.approved'
  | 'recruitment.requisition.rejected'
  | 'recruitment.requisition.closed'
  | 'recruitment.position.created'
  | 'recruitment.position.status_changed';

export interface RecruitmentDomainEvent {
  readonly type: RecruitmentEventType;
  readonly aggregateType: 'recruitment.application' | 'recruitment.requisition' | 'recruitment.position';
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
    aggregateType: 'recruitment.application',
    tenantId: application.tenantId,
    aggregateId: application.id,
    version: application.version,
    occurredAt: application.appliedAt,
    payload: Object.freeze({
      candidateId: application.candidateId,
      positionId: application.positionId,
      consentEvidenceId: application.consentEvidenceId,
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
    aggregateType: 'recruitment.application',
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

export function buildRecruitmentRequisitionEvent(
  requisition: RecruitmentRequisition,
  action: 'created' | 'submitted' | 'approved' | 'rejected' | 'closed',
): RecruitmentDomainEvent {
  return Object.freeze({
    type: `recruitment.requisition.${action}`,
    aggregateType: 'recruitment.requisition',
    tenantId: requisition.tenantId,
    aggregateId: requisition.id,
    version: requisition.version,
    occurredAt: requisition.updatedAt,
    payload: Object.freeze({
      departmentId: requisition.departmentId,
      headcount: requisition.headcount,
      status: requisition.status,
      approvalInstanceId: requisition.approvalInstanceId,
    }),
  });
}

export function buildRecruitmentPositionEvent(
  position: RecruitmentPosition,
  action: 'created' | 'status_changed',
): RecruitmentDomainEvent {
  return Object.freeze({
    type: `recruitment.position.${action}`,
    aggregateType: 'recruitment.position',
    tenantId: position.tenantId,
    aggregateId: position.id,
    version: position.version,
    occurredAt: position.updatedAt,
    payload: Object.freeze({
      requisitionId: position.requisitionId,
      departmentId: position.departmentId,
      headcount: position.headcount,
      status: position.status,
    }),
  });
}
