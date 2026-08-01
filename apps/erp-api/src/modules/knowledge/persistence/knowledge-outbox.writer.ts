import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { KnowledgeDomainEvent } from '../domain/index.js';

type KnowledgeCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/u;
const REPLAY_REASON_PATTERN = /^[A-Z][A-Z0-9_]{7,63}$/u;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const codeSchema = z.string().regex(CODE_PATTERN);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const bpsSchema = z.number().int().min(0).max(10_000);
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
const eventBase = {
  tenantId: safeIdSchema,
  aggregateId: safeIdSchema,
  version: positiveIntegerSchema,
  occurredAt: canonicalInstantSchema,
} as const;
const questionModeSchema = z.enum(['objective', 'subjective', 'mixed']);
const examRunPayloadBase = {
  assignmentId: safeIdSchema,
  courseVersionId: safeIdSchema,
  attemptNumber: z.number().int().min(1).max(10),
  questionMode: questionModeSchema,
} as const;

const knowledgeEventSchema = z.discriminatedUnion('type', [
  courseEventSchema('knowledge.course.created', 'draft'),
  courseEventSchema('knowledge.course.published', 'published'),
  courseEventSchema('knowledge.course.retired', 'retired'),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.assignment.created'),
    payload: z.object({
      onboardingInstanceId: safeIdSchema,
      courseVersionId: safeIdSchema,
      mandatory: z.boolean(),
      status: z.literal('assigned'),
      progressBps: z.literal(0),
      passed: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.assignment.progressed'),
    payload: z.object({
      onboardingInstanceId: safeIdSchema,
      courseVersionId: safeIdSchema,
      mandatory: z.boolean(),
      status: z.enum(['assigned', 'in_progress']),
      progressBps: bpsSchema,
      passed: z.literal(false),
    }).strict().superRefine((payload, context) => {
      if (
        (payload.progressBps === 0) !== (payload.status === 'assigned')
      ) context.addIssue({ code: 'custom', message: 'progress_status_invalid' });
    }),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.assignment.completed'),
    payload: z.object({
      onboardingInstanceId: safeIdSchema,
      courseVersionId: safeIdSchema,
      mandatory: z.boolean(),
      status: z.literal('completed'),
      progressBps: z.literal(10_000),
      passed: z.literal(true),
    }).strict(),
  }).strict(),
  examRunEventSchema('knowledge.exam.run.requested', 'starting', z.literal(false)),
  examRunEventSchema('knowledge.exam.run.started', 'in_progress', z.literal(false)),
  examRunEventSchema('knowledge.exam.run.submitted', 'submitted', z.literal(false)),
  examRunEventSchema('knowledge.exam.run.timed_out', 'submitted', z.literal(true)),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.exam.run.review_pending'),
    payload: z.object({
      ...examRunPayloadBase,
      status: z.literal('pending_review'),
      timedOut: z.boolean(),
    }).strict().superRefine((payload, context) => {
      if (payload.questionMode === 'objective') {
        context.addIssue({ code: 'custom', message: 'review_mode_invalid' });
      }
    }),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.exam.run.dead'),
    payload: z.object({
      ...examRunPayloadBase,
      status: z.literal('dead'),
      timedOut: z.boolean(),
      failureCode: z.string().regex(ERROR_CODE_PATTERN),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('knowledge.exam.run.replayed'),
    payload: z.object({
      ...examRunPayloadBase,
      status: z.enum(['starting', 'in_progress', 'submitted', 'pending_review']),
      timedOut: z.boolean(),
      reasonCode: z.string().regex(REPLAY_REASON_PATTERN),
    }).strict().superRefine((payload, context) => {
      if (
        (payload.status === 'starting' || payload.status === 'in_progress') &&
        payload.timedOut
      ) context.addIssue({ code: 'custom', message: 'replay_timeout_state_invalid' });
      if (payload.status === 'pending_review' && payload.questionMode === 'objective') {
        context.addIssue({ code: 'custom', message: 'replay_review_mode_invalid' });
      }
    }),
  }).strict(),
  z.object({
    ...eventBase,
    version: z.literal(1),
    type: z.literal('knowledge.exam.graded'),
    payload: z.object({
      assignmentId: safeIdSchema,
      attemptNumber: z.number().int().min(1).max(10),
      questionMode: questionModeSchema,
      gradingPolicyVersion: z.string().regex(POLICY_VERSION_PATTERN),
      passingRule: z.enum(['score_threshold', 'all_required_sections']),
      manuallyReviewed: z.boolean(),
      submissionReason: z.enum(['learner', 'timeout']),
      passed: z.boolean(),
    }).strict().superRefine((payload, context) => {
      if (payload.manuallyReviewed !== (payload.questionMode !== 'objective')) {
        context.addIssue({ code: 'custom', message: 'grading_review_mode_invalid' });
      }
    }),
  }).strict(),
  z.object({
    ...eventBase,
    version: z.literal(1),
    type: z.literal('knowledge.onboarding.attested'),
    payload: z.object({
      onboardingInstanceId: safeIdSchema,
      assignmentCount: z.number().int().min(1).max(200),
    }).strict(),
  }).strict(),
]);

/** Knowledge 可靠事件写入器；必须与业务状态变更共用同一活动 Mongo 事务。 */
@Injectable()
export class KnowledgeOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: KnowledgeDomainEvent, session: ClientSession): Promise<string> {
    const trusted = this.requireTrustedContext();
    const canonical = parseEvent(event);
    if (canonical.tenantId !== trusted.tenantId) {
      throw new Error('KNOWLEDGE_OUTBOX_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const eventId = createEventId(new Date(canonical.occurredAt));
    if (!ULID_PATTERN.test(eventId)) throw new Error('KNOWLEDGE_OUTBOX_EVENT_ID_INVALID');
    const eventType = `cn.gaoq.erp.${canonical.type}.v1`;
    const envelope: KnowledgeCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/knowledge-module',
      type: eventType,
      subject: `tenant/${canonical.tenantId}/knowledge/${canonical.aggregateId}`,
      time: canonical.occurredAt,
      datacontenttype: 'application/json',
      tenantId: canonical.tenantId,
      traceId: trusted.traceId,
      idempotencyKey:
        `${canonical.tenantId}:${eventType}:${canonical.aggregateId}:${canonical.version}`,
      schemaVersion: '1',
      data: {
        tenantId: canonical.tenantId,
        aggregateId: canonical.aggregateId,
        version: canonical.version,
        ...canonical.payload,
      },
    };
    const row = {
      eventId,
      tenantId: canonical.tenantId,
      aggregateType: 'knowledge' as const,
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
    return eventId;
  }

  private requireTrustedContext(): { readonly tenantId: string; readonly traceId: string } {
    let trusted: ReturnType<TenantContextService['getRequired']>;
    try {
      trusted = this.context.getRequired();
    } catch {
      throw new Error('KNOWLEDGE_OUTBOX_CONTEXT_INVALID');
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
    ) throw new Error('KNOWLEDGE_OUTBOX_CONTEXT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenant.tenantId,
      traceId: parsed.data.actor.traceId,
    });
  }
}

function courseEventSchema<
  const T extends KnowledgeDomainEvent['type'],
  const S extends 'draft' | 'published' | 'retired',
>(type: T, status: S) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      courseCode: codeSchema,
      revision: positiveIntegerSchema,
      status: z.literal(status),
      audienceMode: z.enum(['assigned_only', 'employment_scope']),
    }).strict(),
  }).strict();
}

function examRunEventSchema<
  const T extends KnowledgeDomainEvent['type'],
  const S extends 'starting' | 'in_progress' | 'submitted' | 'pending_review',
>(
  type: T,
  status: S,
  timedOut: z.ZodType<boolean>,
) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      ...examRunPayloadBase,
      status: z.literal(status),
      timedOut,
    }).strict(),
  }).strict();
}

function parseEvent(value: unknown): z.infer<typeof knowledgeEventSchema> {
  const parsed = knowledgeEventSchema.safeParse(value);
  if (!parsed.success) throw new Error('KNOWLEDGE_OUTBOX_EVENT_INVALID');
  return deepFreeze(parsed.data);
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('KNOWLEDGE_OUTBOX_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('KNOWLEDGE_OUTBOX_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('KNOWLEDGE_OUTBOX_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('KNOWLEDGE_OUTBOX_TRANSACTION_REQUIRED');
}

function assertCreatedRecord(
  created: unknown,
  expected: {
    readonly eventId: string;
    readonly tenantId: string;
    readonly aggregateType: 'knowledge';
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly envelope: KnowledgeCloudEvent;
    readonly status: 'pending';
    readonly attempts: 0;
    readonly nextAttemptAt: Date;
  },
): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('KNOWLEDGE_OUTBOX_WRITE_UNAVAILABLE');
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
  if (!parsed.success) throw new Error('KNOWLEDGE_OUTBOX_WRITE_UNAVAILABLE');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
