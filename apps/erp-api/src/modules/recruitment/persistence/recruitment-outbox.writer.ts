import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type {
  RecruitmentDomainEvent,
  RecruitmentEventType,
} from '../domain/recruitment-events.js';

export type RecruitmentCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

type RecruitmentAggregateType = RecruitmentDomainEvent['aggregateType'];
type ParsedRecruitmentEvent = Omit<RecruitmentDomainEvent, 'payload'> & {
  readonly payload: Readonly<Record<string, unknown>>;
};

interface RecruitmentEventContract {
  readonly aggregateType: RecruitmentAggregateType;
  readonly payload: z.ZodType;
}

const EVENT_TYPES = [
  'recruitment.application.created',
  'recruitment.application.stage_changed',
  'recruitment.application.migrated',
  'recruitment.candidate.migrated',
  'recruitment.requisition.created',
  'recruitment.requisition.submitted',
  'recruitment.requisition.approved',
  'recruitment.requisition.rejected',
  'recruitment.requisition.closed',
  'recruitment.requisition.migrated',
  'recruitment.position.created',
  'recruitment.position.status_changed',
  'recruitment.position.migrated',
  'recruitment.interview.scheduled',
  'recruitment.interview.feedback_submitted',
  'recruitment.interview.completed',
  'recruitment.interview.cancelled',
  'recruitment.interview.migrated',
  'recruitment.offer.created',
  'recruitment.offer.submitted',
  'recruitment.offer.approved',
  'recruitment.offer.rejected',
  'recruitment.offer.send_requested',
  'recruitment.offer.sent',
  'recruitment.offer.accepted',
  'recruitment.offer.declined',
  'recruitment.offer.expired',
  'recruitment.offer.signed',
  'recruitment.offer.migrated',
  'recruitment.resume_analysis.requested',
  'recruitment.resume_analysis.reviewed',
] as const satisfies readonly RecruitmentEventType[];

const AGGREGATE_TYPES = [
  'recruitment.application',
  'recruitment.candidate',
  'recruitment.requisition',
  'recruitment.position',
  'recruitment.interview',
  'recruitment.interview_feedback',
  'recruitment.offer',
  'recruitment.resume_analysis',
] as const satisfies readonly RecruitmentAggregateType[];

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const safeCodeSchema = z.string().regex(SAFE_CODE_PATTERN);
const nullableIdSchema = safeIdSchema.nullable();
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const canonicalInstantSchema = z.string().refine(isCanonicalInstant);
const canonicalPastInstantSchema = canonicalInstantSchema.refine(
  (value) => Date.parse(value) <= Date.now(),
);
const applicationStageSchema = z.enum([
  'applied',
  'screening',
  'interview',
  'offer_approval',
  'offer_sent',
  'offer_accepted',
  'preboarding',
  'hired',
  'rejected',
  'withdrawn',
]);
const positionStatusSchema = z.enum(['draft', 'open', 'paused', 'closed']);
const interviewStatusSchema = z.enum(['scheduled', 'completed', 'cancelled']);
const offerStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'sending',
  'sent',
  'accepted',
  'declined',
  'expired',
  'cancelled',
  'signed',
]);
const headcountSchema = z.number().int().min(1).max(10_000);
const roundNumberSchema = z.number().int().min(1).max(100);
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const eventBaseSchema = z.object({
  type: z.enum(EVENT_TYPES),
  aggregateType: z.enum(AGGREGATE_TYPES),
  tenantId: safeIdSchema,
  aggregateId: safeIdSchema,
  version: positiveIntegerSchema,
  occurredAt: canonicalPastInstantSchema,
  payload: z.unknown(),
}).strict();

const applicationCreatedPayload = z.object({
  candidateId: safeIdSchema,
  positionId: safeIdSchema,
  consentEvidenceId: safeIdSchema,
  sourceChannel: safeCodeSchema,
  stage: z.literal('applied'),
}).strict();

const applicationMigratedPayload = z.object({
  candidateId: safeIdSchema,
  positionId: safeIdSchema,
  stage: z.enum(['applied', 'screening', 'interview', 'rejected', 'withdrawn']),
}).strict();

const applicationStageChangedPayload = z.object({
  from: applicationStageSchema,
  to: applicationStageSchema,
  actorId: safeIdSchema,
  reasonCode: safeCodeSchema.nullable(),
  evidenceId: nullableIdSchema,
}).strict()
  .refine(
    ({ from, to }) => ALLOWED_APPLICATION_TRANSITIONS.has(`${from}:${to}`),
  )
  .refine(
    ({ to, reasonCode }) => !['rejected', 'withdrawn'].includes(to) || reasonCode !== null,
  )
  .refine(
    ({ to, evidenceId }) => !APPLICATION_EVIDENCE_STAGES.has(to) || evidenceId !== null,
  );

const candidateMigratedPayload = z.object({
  status: z.enum(['active', 'consent_withdrawn', 'anonymized']),
  consentEvidenceId: safeIdSchema,
  consentVersion: safeCodeSchema,
}).strict();

const requisitionCreatedPayload = requisitionPayload(
  z.literal('draft'),
  z.null(),
  z.null(),
);
const requisitionSubmittedPayload = requisitionPayload(
  z.literal('pending_approval'),
  safeIdSchema,
  z.null(),
);
const requisitionApprovedPayload = approvedRequisitionPayload(z.literal('approved'));
const requisitionRejectedPayload = approvedRequisitionPayload(z.literal('rejected'));
const requisitionClosedPayload = approvedRequisitionPayload(z.literal('closed'));
const requisitionMigratedPayload = z.union([
  requisitionCreatedPayload,
  requisitionSubmittedPayload,
  approvedRequisitionPayload(z.enum(['approved', 'rejected', 'closed'])),
]);

const positionCreatedPayload = positionPayload(z.literal('draft'));
const positionChangedPayload = positionPayload(z.enum(['open', 'paused', 'closed']));
const positionMigratedPayload = positionPayload(positionStatusSchema);

const interviewScheduledPayload = interviewPayload(z.literal('scheduled'));
const interviewCompletedPayload = interviewPayload(z.literal('completed'));
const interviewCancelledPayload = interviewPayload(z.literal('cancelled'));
const interviewFeedbackPayload = z.object({
  applicationId: safeIdSchema,
  feedbackId: safeIdSchema,
  interviewerId: safeIdSchema,
}).strict();
const interviewMigratedPayload = z.object({
  applicationId: safeIdSchema,
  roundNumber: roundNumberSchema,
  status: interviewStatusSchema,
  feedbackCount: z.number().int().min(0).max(20),
}).strict();

const offerCreatedPayload = offerPayload(
  z.literal('draft'),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
);
const offerSubmittedPayload = offerPayload(
  z.literal('pending_approval'),
  safeIdSchema,
  z.null(),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
  z.null(),
);
const offerApprovedPayload = approvedOfferPayload(z.literal('approved'));
const offerRejectedPayload = approvedOfferPayload(z.literal('rejected'));
const offerSendRequestedPayload = postApprovalOfferPayload(
  z.literal('sending'),
  safeIdSchema,
  z.null(),
  z.null(),
  z.null(),
  z.null(),
);
const offerSentPayload = postApprovalOfferPayload(
  z.literal('sent'),
  safeIdSchema,
  safeIdSchema,
  z.null(),
  z.null(),
  z.null(),
);
const offerAcceptedPayload = decidedOfferPayload(z.literal('accepted'));
const offerDeclinedPayload = decidedOfferPayload(z.literal('declined'));
const offerSignedPayload = postApprovalOfferPayload(
  z.literal('signed'),
  safeIdSchema,
  safeIdSchema,
  safeIdSchema,
  safeIdSchema,
  safeIdSchema,
);
const offerExpiredPayload = z.union([
  postApprovalOfferPayload(
    z.literal('expired'),
    z.null(),
    z.null(),
    z.null(),
    z.null(),
    z.null(),
  ),
  postApprovalOfferPayload(
    z.literal('expired'),
    safeIdSchema,
    z.null(),
    z.null(),
    z.null(),
    z.null(),
  ),
  postApprovalOfferPayload(
    z.literal('expired'),
    safeIdSchema,
    safeIdSchema,
    z.null(),
    z.null(),
    z.null(),
  ),
]);
const offerMigratedPayload = z.object({
  applicationId: safeIdSchema,
  positionId: safeIdSchema,
  completedInterviewId: safeIdSchema,
  status: offerStatusSchema,
  approvalInstanceId: nullableIdSchema,
  approvalHistoryId: nullableIdSchema,
}).strict().refine(({ status, approvalInstanceId, approvalHistoryId }) => {
  if (status === 'draft') return approvalInstanceId === null && approvalHistoryId === null;
  if (status === 'pending_approval') {
    return approvalInstanceId !== null && approvalHistoryId === null;
  }
  return approvalInstanceId === null && approvalHistoryId !== null;
});

const resumeRequestedPayload = z.object({
  candidateId: safeIdSchema,
  resumeEvidenceId: safeIdSchema,
  status: z.literal('queued'),
  confirmedTagCount: z.literal(0),
}).strict();
const resumeReviewedPayload = z.object({
  candidateId: safeIdSchema,
  resumeEvidenceId: safeIdSchema,
  status: z.literal('approved'),
  confirmedTagCount: countSchema,
}).strict();

const EVENT_CONTRACTS = Object.freeze({
  'recruitment.application.created':
    contract('recruitment.application', applicationCreatedPayload),
  'recruitment.application.stage_changed':
    contract('recruitment.application', applicationStageChangedPayload),
  'recruitment.application.migrated':
    contract('recruitment.application', applicationMigratedPayload),
  'recruitment.candidate.migrated':
    contract('recruitment.candidate', candidateMigratedPayload),
  'recruitment.requisition.created':
    contract('recruitment.requisition', requisitionCreatedPayload),
  'recruitment.requisition.submitted':
    contract('recruitment.requisition', requisitionSubmittedPayload),
  'recruitment.requisition.approved':
    contract('recruitment.requisition', requisitionApprovedPayload),
  'recruitment.requisition.rejected':
    contract('recruitment.requisition', requisitionRejectedPayload),
  'recruitment.requisition.closed':
    contract('recruitment.requisition', requisitionClosedPayload),
  'recruitment.requisition.migrated':
    contract('recruitment.requisition', requisitionMigratedPayload),
  'recruitment.position.created':
    contract('recruitment.position', positionCreatedPayload),
  'recruitment.position.status_changed':
    contract('recruitment.position', positionChangedPayload),
  'recruitment.position.migrated':
    contract('recruitment.position', positionMigratedPayload),
  'recruitment.interview.scheduled':
    contract('recruitment.interview', interviewScheduledPayload),
  'recruitment.interview.feedback_submitted':
    contract('recruitment.interview_feedback', interviewFeedbackPayload),
  'recruitment.interview.completed':
    contract('recruitment.interview', interviewCompletedPayload),
  'recruitment.interview.cancelled':
    contract('recruitment.interview', interviewCancelledPayload),
  'recruitment.interview.migrated':
    contract('recruitment.interview', interviewMigratedPayload),
  'recruitment.offer.created':
    contract('recruitment.offer', offerCreatedPayload),
  'recruitment.offer.submitted':
    contract('recruitment.offer', offerSubmittedPayload),
  'recruitment.offer.approved':
    contract('recruitment.offer', offerApprovedPayload),
  'recruitment.offer.rejected':
    contract('recruitment.offer', offerRejectedPayload),
  'recruitment.offer.send_requested':
    contract('recruitment.offer', offerSendRequestedPayload),
  'recruitment.offer.sent':
    contract('recruitment.offer', offerSentPayload),
  'recruitment.offer.accepted':
    contract('recruitment.offer', offerAcceptedPayload),
  'recruitment.offer.declined':
    contract('recruitment.offer', offerDeclinedPayload),
  'recruitment.offer.expired':
    contract('recruitment.offer', offerExpiredPayload),
  'recruitment.offer.signed':
    contract('recruitment.offer', offerSignedPayload),
  'recruitment.offer.migrated':
    contract('recruitment.offer', offerMigratedPayload),
  'recruitment.resume_analysis.requested':
    contract('recruitment.resume_analysis', resumeRequestedPayload),
  'recruitment.resume_analysis.reviewed':
    contract('recruitment.resume_analysis', resumeReviewedPayload),
}) satisfies Readonly<Record<RecruitmentEventType, RecruitmentEventContract>>;

/** 招聘可靠事件写入器；必须与招聘聚合和证据变更共用同一活动 Mongo 事务。 */
@Injectable()
export class RecruitmentOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    event: RecruitmentDomainEvent,
    session: ClientSession,
  ): Promise<RecruitmentCloudEvent> {
    const trusted = this.requireTrustedContext();
    const canonical = parseEvent(event);
    if (canonical.tenantId !== trusted.tenantId) {
      throw new Error('RECRUITMENT_OUTBOX_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const eventId = createEventId(new Date(canonical.occurredAt));
    if (!ULID_PATTERN.test(eventId)) throw new Error('RECRUITMENT_OUTBOX_EVENT_ID_INVALID');
    const eventType = `cn.gaoq.erp.${canonical.type}.v1`;
    const envelope: RecruitmentCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/recruitment-module',
      type: eventType,
      subject:
        `tenant/${canonical.tenantId}/${canonical.aggregateType}/${canonical.aggregateId}`,
      time: canonical.occurredAt,
      datacontenttype: 'application/json',
      tenantId: canonical.tenantId,
      traceId: trusted.traceId,
      idempotencyKey:
        `${canonical.tenantId}:${eventType}:${canonical.aggregateId}:${canonical.version}`,
      schemaVersion: '1',
      data: {
        ...canonical.payload,
        tenantId: canonical.tenantId,
        aggregateId: canonical.aggregateId,
        version: canonical.version,
      },
    };
    const row = {
      eventId,
      tenantId: canonical.tenantId,
      aggregateType: canonical.aggregateType,
      aggregateId: canonical.aggregateId,
      aggregateVersion: canonical.version,
      eventType,
      envelope: { ...envelope },
      status: 'pending' as const,
      attempts: 0 as const,
      nextAttemptAt: new Date(canonical.occurredAt),
    };
    const created = await this.records.create([row], { session });
    assertCreatedRecord(created, row);
    return envelope;
  }

  private requireTrustedContext(): { readonly tenantId: string; readonly traceId: string } {
    let trusted: ReturnType<TenantContextService['getRequired']>;
    try {
      trusted = this.context.getRequired();
    } catch {
      throw new Error('RECRUITMENT_OUTBOX_CONTEXT_INVALID');
    }
    const parsed = z.object({
      tenant: z.object({ tenantId: safeIdSchema }).passthrough(),
      actor: z.object({
        tenantId: safeIdSchema,
        traceId: safeIdSchema,
      }).passthrough(),
    }).strict().safeParse(trusted);
    if (
      !parsed.success ||
      parsed.data.tenant.tenantId !== parsed.data.actor.tenantId
    ) throw new Error('RECRUITMENT_OUTBOX_CONTEXT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenant.tenantId,
      traceId: parsed.data.actor.traceId,
    });
  }
}

function contract(
  aggregateType: RecruitmentAggregateType,
  payload: z.ZodType,
): RecruitmentEventContract {
  return Object.freeze({ aggregateType, payload });
}

function requisitionPayload(
  status: z.ZodType,
  approvalInstanceId: z.ZodType,
  approvalHistoryId: z.ZodType,
): z.ZodType {
  return z.object({
    departmentId: safeIdSchema,
    headcount: headcountSchema,
    status,
    approvalInstanceId,
    approvalHistoryId,
  }).strict();
}

function approvedRequisitionPayload(status: z.ZodType): z.ZodType {
  return z.union([
    requisitionPayload(status, safeIdSchema, z.null()),
    requisitionPayload(status, z.null(), safeIdSchema),
  ]);
}

function positionPayload(status: z.ZodType): z.ZodType {
  return z.object({
    requisitionId: safeIdSchema,
    departmentId: safeIdSchema,
    headcount: headcountSchema,
    status,
  }).strict();
}

function interviewPayload(status: z.ZodType): z.ZodType {
  return z.object({
    applicationId: safeIdSchema,
    roundNumber: roundNumberSchema,
    status,
    startsAt: canonicalInstantSchema,
    endsAt: canonicalInstantSchema,
  }).strict().refine(
    ({ startsAt, endsAt }) => {
      const duration = Date.parse(endsAt) - Date.parse(startsAt);
      return duration > 0 && duration <= 12 * 60 * 60 * 1_000;
    },
  );
}

function offerPayload(
  status: z.ZodType,
  approvalInstanceId: z.ZodType,
  approvalHistoryId: z.ZodType,
  sendRequestId: z.ZodType,
  sentEvidenceId: z.ZodType,
  acceptanceEvidenceId: z.ZodType,
  esignFlowId: z.ZodType,
  signedEvidenceId: z.ZodType,
): z.ZodType {
  return z.object({
    applicationId: safeIdSchema,
    positionId: safeIdSchema,
    status,
    approvalInstanceId,
    approvalHistoryId,
    sendRequestId,
    sentEvidenceId,
    acceptanceEvidenceId,
    esignFlowId,
    signedEvidenceId,
  }).strict();
}

function approvedOfferPayload(status: z.ZodType): z.ZodType {
  return z.union([
    offerPayload(
      status,
      safeIdSchema,
      z.null(),
      z.null(),
      z.null(),
      z.null(),
      z.null(),
      z.null(),
    ),
    offerPayload(
      status,
      z.null(),
      safeIdSchema,
      z.null(),
      z.null(),
      z.null(),
      z.null(),
      z.null(),
    ),
  ]);
}

function postApprovalOfferPayload(
  status: z.ZodType,
  sendRequestId: z.ZodType,
  sentEvidenceId: z.ZodType,
  acceptanceEvidenceId: z.ZodType,
  esignFlowId: z.ZodType,
  signedEvidenceId: z.ZodType,
): z.ZodType {
  return z.union([
    offerPayload(
      status,
      safeIdSchema,
      z.null(),
      sendRequestId,
      sentEvidenceId,
      acceptanceEvidenceId,
      esignFlowId,
      signedEvidenceId,
    ),
    offerPayload(
      status,
      z.null(),
      safeIdSchema,
      sendRequestId,
      sentEvidenceId,
      acceptanceEvidenceId,
      esignFlowId,
      signedEvidenceId,
    ),
  ]);
}

function decidedOfferPayload(status: z.ZodType): z.ZodType {
  return postApprovalOfferPayload(
    status,
    safeIdSchema,
    safeIdSchema,
    safeIdSchema,
    z.null(),
    z.null(),
  );
}

/** 将编译期事件收敛为逐类型、无未知字段的运行时可信副本。 */
function parseEvent(value: unknown): ParsedRecruitmentEvent {
  const parsed = eventBaseSchema.safeParse(value);
  if (!parsed.success) throw new Error('RECRUITMENT_OUTBOX_EVENT_INVALID');
  const contract = EVENT_CONTRACTS[parsed.data.type];
  if (parsed.data.aggregateType !== contract.aggregateType) {
    throw new Error('RECRUITMENT_OUTBOX_EVENT_INVALID');
  }
  const payload = contract.payload.safeParse(parsed.data.payload);
  if (!payload.success || payload.data === null || typeof payload.data !== 'object') {
    throw new Error('RECRUITMENT_OUTBOX_EVENT_INVALID');
  }
  const canonical = {
    ...parsed.data,
    payload: payload.data as Readonly<Record<string, unknown>>,
  };
  assertEventRelations(canonical);
  return deepFreeze(canonical);
}

function assertEventRelations(event: ParsedRecruitmentEvent): void {
  if (
    event.type === 'recruitment.interview.feedback_submitted' &&
    event.payload['feedbackId'] !== event.aggregateId
  ) throw new Error('RECRUITMENT_OUTBOX_EVENT_INVALID');
  if (event.type === 'recruitment.interview.migrated') {
    const feedbackCount = event.payload['feedbackCount'];
    const status = event.payload['status'];
    const expected = event.version - (status === 'scheduled' ? 1 : 2);
    if (feedbackCount !== expected) throw new Error('RECRUITMENT_OUTBOX_EVENT_INVALID');
  }
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('RECRUITMENT_OUTBOX_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('RECRUITMENT_OUTBOX_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('RECRUITMENT_OUTBOX_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('RECRUITMENT_OUTBOX_TRANSACTION_REQUIRED');
}

function assertCreatedRecord(
  created: unknown,
  expected: {
    readonly eventId: string;
    readonly tenantId: string;
    readonly aggregateType: RecruitmentAggregateType;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly envelope: RecruitmentCloudEvent;
    readonly status: 'pending';
    readonly attempts: 0;
    readonly nextAttemptAt: Date;
  },
): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('RECRUITMENT_OUTBOX_WRITE_UNAVAILABLE');
  }
  const parsed = z.object({
    eventId: z.literal(expected.eventId),
    tenantId: z.literal(expected.tenantId),
    aggregateType: z.literal(expected.aggregateType),
    aggregateId: z.literal(expected.aggregateId),
    aggregateVersion: z.literal(expected.aggregateVersion),
    eventType: z.literal(expected.eventType),
    envelope: z.custom((value) => isDeepStrictEqual(value, expected.envelope)),
    status: z.literal(expected.status),
    attempts: z.literal(expected.attempts),
    nextAttemptAt: z.date().refine(
      (value) => value.getTime() === expected.nextAttemptAt.getTime(),
    ),
  }).passthrough().safeParse(created[0]);
  if (!parsed.success) throw new Error('RECRUITMENT_OUTBOX_WRITE_UNAVAILABLE');
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const ALLOWED_APPLICATION_TRANSITIONS = new Set([
  'applied:screening',
  'applied:rejected',
  'applied:withdrawn',
  'screening:interview',
  'screening:rejected',
  'screening:withdrawn',
  'interview:offer_approval',
  'interview:rejected',
  'interview:withdrawn',
  'offer_approval:offer_sent',
  'offer_approval:rejected',
  'offer_approval:withdrawn',
  'offer_sent:offer_accepted',
  'offer_sent:rejected',
  'offer_sent:withdrawn',
  'offer_accepted:preboarding',
  'offer_accepted:withdrawn',
  'preboarding:hired',
  'preboarding:withdrawn',
]);
const APPLICATION_EVIDENCE_STAGES = new Set([
  'offer_approval',
  'offer_sent',
  'offer_accepted',
  'preboarding',
  'hired',
]);
