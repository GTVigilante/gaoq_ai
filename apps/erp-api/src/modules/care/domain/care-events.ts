import type { AlumniConsent, CareCase } from './care.js';
import type {
  CareOccasionPreference,
  CareOccasionTask,
} from './care-occasion.js';

export interface CareDomainEvent {
  readonly type:
    | 'care.case.created'
    | 'care.case.approval_submitted'
    | 'care.case.approved'
    | 'care.case.rejected'
    | 'care.case.task_completed'
    | 'care.case.scheduled'
    | 'care.case.execution_started'
    | 'care.case.completed';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AlumniConsentDomainEvent {
  readonly type:
    | 'care.alumni_consent.granted'
    | 'care.alumni_consent.withdrawn'
    | 'care.alumni_consent.expired';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CareOccasionDomainEvent {
  readonly type:
    | 'care.occasion.preference_updated'
    | 'care.occasion.unsubscribed'
    | 'care.occasion.scheduled'
    | 'care.occasion.delivered'
    | 'care.occasion.cancelled'
    | 'care.occasion.dead'
    | 'care.occasion.replayed';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function careCaseEvent(
  careCase: CareCase,
  type: CareDomainEvent['type'],
  extra: Readonly<Record<string, unknown>> = {},
): CareDomainEvent {
  return Object.freeze({
    type, tenantId: careCase.tenantId, aggregateId: careCase.id,
    version: careCase.version, occurredAt: careCase.updatedAt,
    payload: Object.freeze({
      employeeId: careCase.employeeId, employmentId: careCase.employmentId,
      separationType: careCase.separationType, reasonCode: careCase.reasonCode,
      lastWorkingDate: careCase.lastWorkingDate, accessDisableAt: careCase.accessDisableAt,
      status: careCase.status, ...extra,
    }),
  });
}

export function alumniConsentEvent(
  consent: AlumniConsent,
  type: AlumniConsentDomainEvent['type'],
): AlumniConsentDomainEvent {
  return Object.freeze({
    type, tenantId: consent.tenantId, aggregateId: consent.id, version: consent.version,
    occurredAt: consent.expiredAt ?? consent.withdrawnAt ?? consent.grantedAt,
    payload: Object.freeze({
      careCaseId: consent.careCaseId, purpose: consent.purpose,
      channels: consent.channels, status: consent.status, expiresAt: consent.expiresAt,
    }),
  });
}

/** 关怀偏好事件仅发布目的、开关和状态，不包含生日、联系方式或通知正文。 */
export function careOccasionPreferenceEvent(
  preference: CareOccasionPreference,
  type: Extract<
    CareOccasionDomainEvent['type'],
    'care.occasion.preference_updated' | 'care.occasion.unsubscribed'
  >,
): CareOccasionDomainEvent {
  return Object.freeze({
    type,
    tenantId: preference.tenantId,
    aggregateId: preference.id,
    version: preference.version,
    occurredAt: preference.updatedAt,
    payload: Object.freeze({
      purpose: 'employee_care',
      birthdayEnabled: preference.birthdayEnabled,
      anniversaryEnabled: preference.anniversaryEnabled,
      unsubscribed: preference.unsubscribed,
    }),
  });
}

/** 关怀任务事件只暴露受控类型和终态，不包含员工、生日、渠道地址或正文。 */
export function careOccasionTaskEvent(
  task: CareOccasionTask,
  type: Extract<
    CareOccasionDomainEvent['type'],
    | 'care.occasion.scheduled'
    | 'care.occasion.delivered'
    | 'care.occasion.cancelled'
    | 'care.occasion.dead'
  >,
): CareOccasionDomainEvent {
  return Object.freeze({
    type,
    tenantId: task.tenantId,
    aggregateId: task.id,
    version: task.version,
    occurredAt: task.updatedAt,
    payload: Object.freeze({
      purpose: 'employee_care',
      occasionType: task.occasionType,
      status: task.status,
      policyVersion: task.policyVersion,
      attempts: task.attempts,
      ...(task.denialCode === null ? {} : { denialCode: task.denialCode }),
    }),
  });
}

/** 运维重放事件仅增加受控原因码，不接受自由文本。 */
export function careOccasionTaskReplayedEvent(
  task: CareOccasionTask,
  reasonCode: string,
): CareOccasionDomainEvent {
  if (!/^[A-Z][A-Z0-9_]{7,63}$/.test(reasonCode)) {
    throw new Error('CARE_OCCASION_REPLAY_REASON_INVALID');
  }
  return Object.freeze({
    type: 'care.occasion.replayed',
    tenantId: task.tenantId,
    aggregateId: task.id,
    version: task.version,
    occurredAt: task.updatedAt,
    payload: Object.freeze({
      purpose: 'employee_care',
      occasionType: task.occasionType,
      status: task.status,
      policyVersion: task.policyVersion,
      attempts: task.attempts,
      reasonCode,
    }),
  });
}
