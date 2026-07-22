import type { CandidateApplication, CandidateApplicationStageEvent } from './application.js';
import type { Candidate } from './candidate.js';
import type { RecruitmentInterview, RecruitmentInterviewFeedback } from './interview.js';
import type { RecruitmentOffer } from './offer.js';
import type { RecruitmentPosition } from './position.js';
import type { RecruitmentRequisition } from './requisition.js';

export type RecruitmentEventType =
  | 'recruitment.application.created'
  | 'recruitment.application.stage_changed'
  | 'recruitment.application.migrated'
  | 'recruitment.candidate.migrated'
  | 'recruitment.requisition.created'
  | 'recruitment.requisition.submitted'
  | 'recruitment.requisition.approved'
  | 'recruitment.requisition.rejected'
  | 'recruitment.requisition.closed'
  | 'recruitment.requisition.migrated'
  | 'recruitment.position.created'
  | 'recruitment.position.status_changed'
  | 'recruitment.position.migrated'
  | 'recruitment.interview.scheduled'
  | 'recruitment.interview.feedback_submitted'
  | 'recruitment.interview.completed'
  | 'recruitment.interview.cancelled'
  | 'recruitment.interview.migrated'
  | 'recruitment.offer.created'
  | 'recruitment.offer.submitted'
  | 'recruitment.offer.approved'
  | 'recruitment.offer.rejected'
  | 'recruitment.offer.send_requested'
  | 'recruitment.offer.sent'
  | 'recruitment.offer.accepted'
  | 'recruitment.offer.declined'
  | 'recruitment.offer.expired'
  | 'recruitment.offer.signed'
  | 'recruitment.offer.migrated';

export interface RecruitmentDomainEvent {
  readonly type: RecruitmentEventType;
  readonly aggregateType:
    | 'recruitment.application'
    | 'recruitment.candidate'
    | 'recruitment.requisition'
    | 'recruitment.position'
    | 'recruitment.interview'
    | 'recruitment.interview_feedback'
    | 'recruitment.offer';
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

/** 申请迁移事件只披露聚合引用与当前阶段，不重放历史动作。 */
export function buildCandidateApplicationMigratedEvent(
  application: CandidateApplication,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.application.migrated',
    aggregateType: 'recruitment.application',
    tenantId: application.tenantId,
    aggregateId: application.id,
    version: application.version,
    occurredAt: application.updatedAt,
    payload: Object.freeze({
      candidateId: application.candidateId,
      positionId: application.positionId,
      stage: application.stage,
    }),
  });
}

/** 候选人迁移事件不包含姓名、联系方式、授权目的或保留期。 */
export function buildCandidateMigratedEvent(candidate: Candidate): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.candidate.migrated',
    aggregateType: 'recruitment.candidate',
    tenantId: candidate.tenantId,
    aggregateId: candidate.id,
    version: candidate.version,
    occurredAt: candidate.updatedAt,
    payload: Object.freeze({
      status: candidate.status,
      consentEvidenceId: candidate.consent.evidenceId,
      consentVersion: candidate.consent.version,
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
      approvalHistoryId: requisition.approvalHistoryId,
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

/** HC 迁移事件不伪装成创建或审批动作，只披露控制状态与审批引用。 */
export function buildRecruitmentRequisitionMigratedEvent(
  requisition: RecruitmentRequisition,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.requisition.migrated',
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
      approvalHistoryId: requisition.approvalHistoryId,
    }),
  });
}

/** 职位迁移事件只披露主数据引用和生命周期状态。 */
export function buildRecruitmentPositionMigratedEvent(
  position: RecruitmentPosition,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.position.migrated',
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

/** 面试事件不携带地点、会议链接或评价原文。 */
export function buildRecruitmentInterviewEvent(
  interview: RecruitmentInterview,
  action: 'scheduled' | 'completed' | 'cancelled',
): RecruitmentDomainEvent {
  return Object.freeze({
    type: `recruitment.interview.${action}`,
    aggregateType: 'recruitment.interview',
    tenantId: interview.tenantId,
    aggregateId: interview.id,
    version: interview.version,
    occurredAt: interview.updatedAt,
    payload: Object.freeze({
      applicationId: interview.applicationId,
      roundNumber: interview.roundNumber,
      status: interview.status,
      startsAt: interview.startsAt,
      endsAt: interview.endsAt,
    }),
  });
}

/** 面试迁移事件只披露控制状态，不输出地点、会议链接或评价内容。 */
export function buildRecruitmentInterviewMigratedEvent(
  interview: RecruitmentInterview,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.interview.migrated',
    aggregateType: 'recruitment.interview',
    tenantId: interview.tenantId,
    aggregateId: interview.id,
    version: interview.version,
    occurredAt: interview.updatedAt,
    payload: Object.freeze({
      applicationId: interview.applicationId,
      roundNumber: interview.roundNumber,
      status: interview.status,
      feedbackCount: interview.version - (interview.status === 'scheduled' ? 1 : 2),
    }),
  });
}

export function buildRecruitmentInterviewFeedbackEvent(
  interview: RecruitmentInterview,
  feedback: RecruitmentInterviewFeedback,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.interview.feedback_submitted',
    aggregateType: 'recruitment.interview_feedback',
    tenantId: feedback.tenantId,
    aggregateId: feedback.id,
    version: 1,
    occurredAt: feedback.submittedAt,
    payload: Object.freeze({
      applicationId: interview.applicationId,
      feedbackId: feedback.id,
      interviewerId: feedback.interviewerId,
    }),
  });
}

/** Offer 事件只传递状态与证据引用，绝不复制 L4 条款或候选人身份原文。 */
export function buildRecruitmentOfferEvent(
  offer: RecruitmentOffer,
  action:
    | 'created'
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'send_requested'
    | 'sent'
    | 'accepted'
    | 'declined'
    | 'expired'
    | 'signed',
): RecruitmentDomainEvent {
  return Object.freeze({
    type: `recruitment.offer.${action}`,
    aggregateType: 'recruitment.offer',
    tenantId: offer.tenantId,
    aggregateId: offer.id,
    version: offer.version,
    occurredAt: offer.updatedAt,
    payload: Object.freeze({
      applicationId: offer.applicationId,
      positionId: offer.positionId,
      status: offer.status,
      approvalInstanceId: offer.approvalInstanceId,
      approvalHistoryId: offer.approvalHistoryId,
      sendRequestId: offer.sendRequestId,
      sentEvidenceId: offer.sentEvidenceId,
      acceptanceEvidenceId: offer.acceptanceEvidenceId,
      esignFlowId: offer.esignFlowId,
      signedEvidenceId: offer.signedEvidenceId,
    }),
  });
}

/** Offer 迁移事件不输出 L4 条款或外部证据正文。 */
export function buildRecruitmentOfferMigratedEvent(
  offer: RecruitmentOffer,
): RecruitmentDomainEvent {
  return Object.freeze({
    type: 'recruitment.offer.migrated',
    aggregateType: 'recruitment.offer',
    tenantId: offer.tenantId,
    aggregateId: offer.id,
    version: offer.version,
    occurredAt: offer.updatedAt,
    payload: Object.freeze({
      applicationId: offer.applicationId,
      positionId: offer.positionId,
      completedInterviewId: offer.completedInterviewId,
      status: offer.status,
      approvalInstanceId: offer.approvalInstanceId,
      approvalHistoryId: offer.approvalHistoryId,
    }),
  });
}
