import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OutboxRecord,
  type OutboxDocument,
} from '../../org/persistence/outbox.schema.js';
import type { TalentTouchpoint } from '../domain/index.js';

type TalentTouchpointAction = 'created' | 'completed' | 'cancelled';

type TalentTouchpointEventData = Pick<
  TalentTouchpoint,
  | 'candidateId'
  | 'kind'
  | 'channel'
  | 'outcome'
  | 'status'
  | 'occurredAt'
  | 'nextActionAt'
> & {
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
};

type TalentTouchpointCloudEvent = CloudEvent<TalentTouchpointEventData> & {
  readonly schemaVersion: '1';
};

const ACTIONS = ['created', 'completed', 'cancelled'] as const;
const TOUCHPOINT_KINDS = [
  'candidate_outreach',
  'interview_support',
  'offer_support',
  'onboarding_support',
  'employee_care',
  'offboarding_support',
  'alumni_engagement',
  'rehire_contact',
] as const;
const TOUCHPOINT_CHANNELS = [
  'email',
  'phone',
  'wechat',
  'meeting',
  'portal',
  'internal',
] as const;
const TOUCHPOINT_OUTCOMES = [
  'contacted',
  'no_response',
  'follow_up_required',
  'resolved',
  'declined',
  'joined',
  'departed',
  'consent_withdrawn',
] as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const canonicalInstantSchema = z.string().refine(isCanonicalInstant);
const canonicalPastInstantSchema = canonicalInstantSchema.refine(
  (value) => Date.parse(value) <= Date.now(),
);
const canonicalNoteSchema = z.string()
  .min(1)
  .max(1_000)
  .refine((value) => value.normalize('NFKC').trim() === value);

const touchpointSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  tenantId: safeIdSchema,
  candidateId: z.string().regex(ULID_PATTERN),
  kind: z.enum(TOUCHPOINT_KINDS),
  channel: z.enum(TOUCHPOINT_CHANNELS),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  outcome: z.enum(TOUCHPOINT_OUTCOMES),
  ownerActorId: safeIdSchema,
  occurredAt: canonicalInstantSchema,
  nextActionAt: canonicalInstantSchema.nullable(),
  status: z.enum(['open', 'completed', 'cancelled']),
  note: canonicalNoteSchema.nullable(),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: canonicalPastInstantSchema,
  updatedAt: canonicalPastInstantSchema,
}).strict()
  .refine(({ occurredAt, nextActionAt }) =>
    nextActionAt === null || Date.parse(nextActionAt) > Date.parse(occurredAt))
  .refine(({ createdAt, updatedAt }) => Date.parse(createdAt) <= Date.parse(updatedAt));

/** 人才全周期服务触点可靠事件写入器；必须与触点状态变更共用活动 Mongo 事务。 */
@Injectable()
export class TalentLifecycleOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    touchpoint: TalentTouchpoint,
    action: TalentTouchpointAction,
    session: ClientSession,
  ): Promise<void> {
    const trusted = this.requireTrustedContext();
    const canonicalAction = parseAction(action);
    const canonical = parseTouchpoint(touchpoint, canonicalAction);
    if (canonical.tenantId !== trusted.tenantId) {
      throw new Error('TALENT_LIFECYCLE_OUTBOX_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const eventId = createEventId(new Date(canonical.updatedAt));
    if (!ULID_PATTERN.test(eventId)) {
      throw new Error('TALENT_LIFECYCLE_OUTBOX_EVENT_ID_INVALID');
    }
    const eventType = `cn.gaoq.erp.talent.touchpoint.${canonicalAction}.v1`;
    const envelope: TalentTouchpointCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/talent-lifecycle-module',
      type: eventType,
      subject: `tenant/${canonical.tenantId}/talent/touchpoints/${canonical.id}`,
      time: canonical.updatedAt,
      datacontenttype: 'application/json',
      tenantId: canonical.tenantId,
      traceId: trusted.traceId,
      idempotencyKey:
        `${canonical.tenantId}:${eventType}:${canonical.id}:${canonical.version}`,
      schemaVersion: '1',
      data: {
        tenantId: canonical.tenantId,
        aggregateId: canonical.id,
        version: canonical.version,
        candidateId: canonical.candidateId,
        kind: canonical.kind,
        channel: canonical.channel,
        outcome: canonical.outcome,
        status: canonical.status,
        occurredAt: canonical.occurredAt,
        nextActionAt: canonical.nextActionAt,
      },
    };
    const row = {
      eventId,
      tenantId: canonical.tenantId,
      aggregateType: 'talent.touchpoint' as const,
      aggregateId: canonical.id,
      aggregateVersion: canonical.version,
      eventType,
      envelope: { ...envelope },
      status: 'pending' as const,
      attempts: 0 as const,
      nextAttemptAt: new Date(canonical.updatedAt),
    };
    const created = await this.records.create([row], { session });
    assertCreatedRecord(created, row);
  }

  private requireTrustedContext(): { readonly tenantId: string; readonly traceId: string } {
    let trusted: ReturnType<TenantContextService['getRequired']>;
    try {
      trusted = this.context.getRequired();
    } catch {
      throw new Error('TALENT_LIFECYCLE_OUTBOX_CONTEXT_INVALID');
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
    ) throw new Error('TALENT_LIFECYCLE_OUTBOX_CONTEXT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenant.tenantId,
      traceId: parsed.data.actor.traceId,
    });
  }
}

function parseAction(value: unknown): TalentTouchpointAction {
  const parsed = z.enum(ACTIONS).safeParse(value);
  if (!parsed.success) throw new Error('TALENT_LIFECYCLE_OUTBOX_ACTION_INVALID');
  return parsed.data;
}

/** 收敛为无未知字段、无调用方可变引用的触点可信副本。 */
function parseTouchpoint(
  value: unknown,
  action: TalentTouchpointAction,
): TalentTouchpoint {
  const parsed = touchpointSchema.safeParse(value);
  if (!parsed.success || !matchesAction(parsed.data, action)) {
    throw new Error('TALENT_LIFECYCLE_OUTBOX_TOUCHPOINT_INVALID');
  }
  return Object.freeze({ ...parsed.data });
}

function matchesAction(
  touchpoint: z.infer<typeof touchpointSchema>,
  action: TalentTouchpointAction,
): boolean {
  if (action === 'created') {
    return (
      touchpoint.version === 1 &&
      touchpoint.createdAt === touchpoint.updatedAt &&
      (
        (touchpoint.status === 'open' && touchpoint.nextActionAt !== null) ||
        (touchpoint.status === 'completed' && touchpoint.nextActionAt === null)
      )
    );
  }
  return (
    touchpoint.status === action &&
    touchpoint.version === 2 &&
    touchpoint.nextActionAt !== null
  );
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('TALENT_LIFECYCLE_OUTBOX_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('TALENT_LIFECYCLE_OUTBOX_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('TALENT_LIFECYCLE_OUTBOX_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('TALENT_LIFECYCLE_OUTBOX_TRANSACTION_REQUIRED');
}

function assertCreatedRecord(
  created: unknown,
  expected: {
    readonly eventId: string;
    readonly tenantId: string;
    readonly aggregateType: 'talent.touchpoint';
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly envelope: TalentTouchpointCloudEvent;
    readonly status: 'pending';
    readonly attempts: 0;
    readonly nextAttemptAt: Date;
  },
): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('TALENT_LIFECYCLE_OUTBOX_WRITE_UNAVAILABLE');
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
  if (!parsed.success) throw new Error('TALENT_LIFECYCLE_OUTBOX_WRITE_UNAVAILABLE');
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
