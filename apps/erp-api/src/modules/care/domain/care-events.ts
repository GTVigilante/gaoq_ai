import type { AlumniConsent, CareCase } from './care.js';

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
  readonly type: 'care.alumni_consent.granted' | 'care.alumni_consent.withdrawn';
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
    occurredAt: consent.withdrawnAt ?? consent.grantedAt,
    payload: Object.freeze({
      careCaseId: consent.careCaseId, purpose: consent.purpose,
      channels: consent.channels, status: consent.status, expiresAt: consent.expiresAt,
    }),
  });
}
