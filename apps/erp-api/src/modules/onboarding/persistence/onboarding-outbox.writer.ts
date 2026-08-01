import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { OnboardingDomainEvent } from '../domain/index.js';

type OnboardingCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const canonicalPastInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value &&
    parsed.getTime() <= Date.now();
});
const eventBase = {
  tenantId: safeIdSchema,
  aggregateId: safeIdSchema,
  version: positiveIntegerSchema,
  occurredAt: canonicalPastInstantSchema,
} as const;
const onboardingEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('onboarding.created'),
    payload: z.object({
      offerId: safeIdSchema,
      applicationId: safeIdSchema,
      candidateId: safeIdSchema,
      status: z.literal('in_progress'),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('onboarding.task_completed'),
    payload: z.object({
      taskCode: z.enum([
        'contract_archived',
        'identity_verified',
        'materials_verified',
        'org_assignment_verified',
        'mandatory_training_completed',
      ]),
      status: z.enum(['in_progress', 'ready']),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('onboarding.provisioning_started'),
    payload: z.object({
      status: z.literal('provisioning'),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('onboarding.completed'),
    payload: z.object({
      status: z.literal('completed'),
      employmentId: safeIdSchema,
    }).strict(),
  }).strict(),
]);

/** 入职可靠事件写入器；必须与入职聚合和证据变更共用同一活动 Mongo 事务。 */
@Injectable()
export class OnboardingOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: OnboardingDomainEvent, session: ClientSession): Promise<void> {
    const trusted = this.requireTrustedContext();
    const canonical = parseEvent(event);
    if (canonical.tenantId !== trusted.tenantId) {
      throw new Error('ONBOARDING_OUTBOX_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const eventId = createEventId(new Date(canonical.occurredAt));
    if (!ULID_PATTERN.test(eventId)) throw new Error('ONBOARDING_OUTBOX_EVENT_ID_INVALID');
    const eventType = `cn.gaoq.erp.${canonical.type}.v1`;
    const envelope: OnboardingCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/onboarding-module',
      type: eventType,
      subject: `tenant/${canonical.tenantId}/onboarding/${canonical.aggregateId}`,
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
      aggregateType: 'onboarding.instance' as const,
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
  }

  private requireTrustedContext(): { readonly tenantId: string; readonly traceId: string } {
    let trusted: ReturnType<TenantContextService['getRequired']>;
    try {
      trusted = this.context.getRequired();
    } catch {
      throw new Error('ONBOARDING_OUTBOX_CONTEXT_INVALID');
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
    ) throw new Error('ONBOARDING_OUTBOX_CONTEXT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenant.tenantId,
      traceId: parsed.data.actor.traceId,
    });
  }
}

/** 将编译期事件收敛为逐类型、无未知字段的运行时可信副本。 */
function parseEvent(value: unknown): z.infer<typeof onboardingEventSchema> {
  const parsed = onboardingEventSchema.safeParse(value);
  if (!parsed.success) throw new Error('ONBOARDING_OUTBOX_EVENT_INVALID');
  return deepFreeze(parsed.data);
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('ONBOARDING_OUTBOX_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as { readonly inTransaction?: () => unknown }).inTransaction;
  if (typeof inTransaction !== 'function') {
    throw new Error('ONBOARDING_OUTBOX_TRANSACTION_REQUIRED');
  }
  let active: boolean;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('ONBOARDING_OUTBOX_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('ONBOARDING_OUTBOX_TRANSACTION_REQUIRED');
}

function assertCreatedRecord(
  created: unknown,
  expected: {
    readonly eventId: string;
    readonly tenantId: string;
    readonly aggregateType: 'onboarding.instance';
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly envelope: OnboardingCloudEvent;
    readonly status: 'pending';
    readonly attempts: 0;
    readonly nextAttemptAt: Date;
  },
): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('ONBOARDING_OUTBOX_WRITE_UNAVAILABLE');
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
  if (!parsed.success) throw new Error('ONBOARDING_OUTBOX_WRITE_UNAVAILABLE');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
