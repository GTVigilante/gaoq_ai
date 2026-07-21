import type { OnboardingInstance, OnboardingTaskCode } from './onboarding.js';

export interface OnboardingDomainEvent {
  readonly type:
    | 'onboarding.created'
    | 'onboarding.task_completed'
    | 'onboarding.provisioning_started'
    | 'onboarding.completed';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function buildOnboardingCreatedEvent(instance: OnboardingInstance): OnboardingDomainEvent {
  return event(instance, 'onboarding.created', {
    offerId: instance.offerId,
    applicationId: instance.applicationId,
    candidateId: instance.candidateId,
    status: instance.status,
  });
}

export function buildOnboardingTaskCompletedEvent(
  instance: OnboardingInstance,
  taskCode: OnboardingTaskCode,
): OnboardingDomainEvent {
  return event(instance, 'onboarding.task_completed', { taskCode, status: instance.status });
}

export function buildOnboardingProvisioningStartedEvent(
  instance: OnboardingInstance,
): OnboardingDomainEvent {
  return event(instance, 'onboarding.provisioning_started', { status: instance.status });
}

export function buildOnboardingCompletedEvent(instance: OnboardingInstance): OnboardingDomainEvent {
  return event(instance, 'onboarding.completed', {
    status: instance.status,
    employmentId: instance.employmentId,
  });
}

function event(
  instance: OnboardingInstance,
  type: OnboardingDomainEvent['type'],
  payload: Readonly<Record<string, unknown>>,
): OnboardingDomainEvent {
  return Object.freeze({
    type, tenantId: instance.tenantId, aggregateId: instance.id,
    version: instance.version, occurredAt: instance.updatedAt, payload,
  });
}
