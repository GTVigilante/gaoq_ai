import type { CourseVersion, ExamAttempt, TrainingAssignment } from './training.js';

export interface KnowledgeDomainEvent {
  readonly type:
    | 'knowledge.course.created'
    | 'knowledge.course.published'
    | 'knowledge.course.retired'
    | 'knowledge.assignment.created'
    | 'knowledge.assignment.progressed'
    | 'knowledge.exam.graded'
    | 'knowledge.assignment.completed'
    | 'knowledge.onboarding.attested';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function courseEvent(
  course: CourseVersion,
  type: 'knowledge.course.created' | 'knowledge.course.published' | 'knowledge.course.retired',
): KnowledgeDomainEvent {
  return event(type, course.tenantId, course.id, course.version, course.updatedAt, {
    courseCode: course.courseCode,
    revision: course.revision,
    status: course.status,
    audienceMode: course.audienceMode,
  });
}

export function assignmentEvent(
  assignment: TrainingAssignment,
  type:
    | 'knowledge.assignment.created'
    | 'knowledge.assignment.progressed'
    | 'knowledge.assignment.completed',
): KnowledgeDomainEvent {
  return event(type, assignment.tenantId, assignment.id, assignment.version, assignment.updatedAt, {
    onboardingInstanceId: assignment.onboardingInstanceId,
    courseVersionId: assignment.courseVersionId,
    mandatory: assignment.mandatory,
    status: assignment.status,
    progressBps: assignment.progressBps,
    passed: assignment.status === 'completed',
  });
}

export function examGradedEvent(attempt: ExamAttempt): KnowledgeDomainEvent {
  return event(
    'knowledge.exam.graded', attempt.tenantId, attempt.id, 1, attempt.gradedAt,
    { assignmentId: attempt.assignmentId, attemptNumber: attempt.attemptNumber, passed: attempt.passed },
  );
}

export function onboardingAttestedEvent(input: {
  readonly tenantId: string;
  readonly id: string;
  readonly onboardingInstanceId: string;
  readonly assignmentCount: number;
  readonly attestedAt: string;
}): KnowledgeDomainEvent {
  return event(
    'knowledge.onboarding.attested', input.tenantId, input.id, 1, input.attestedAt,
    { onboardingInstanceId: input.onboardingInstanceId, assignmentCount: input.assignmentCount },
  );
}

function event(
  type: KnowledgeDomainEvent['type'],
  tenantId: string,
  aggregateId: string,
  version: number,
  occurredAt: string,
  payload: Readonly<Record<string, unknown>>,
): KnowledgeDomainEvent {
  return Object.freeze({ type, tenantId, aggregateId, version, occurredAt, payload });
}
