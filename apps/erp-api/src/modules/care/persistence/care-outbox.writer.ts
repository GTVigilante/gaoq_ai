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
  AlumniCleanupDomainEvent,
  AlumniConsentDomainEvent,
  CareDomainEvent,
  CareOccasionDomainEvent,
} from '../domain/index.js';

type CarePublishedDomainEvent =
  | CareDomainEvent
  | AlumniConsentDomainEvent
  | AlumniCleanupDomainEvent
  | CareOccasionDomainEvent;

type CareCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const REPLAY_REASON_PATTERN = /^[A-Z][A-Z0-9_]{7,63}$/;
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveAttemptSchema = z.number().int().min(1).max(10_000);
const idSchema = z.string().regex(ID_PATTERN);
const codeSchema = z.string().regex(CODE_PATTERN);
const utcInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return parsed.toISOString().slice(0, 10) === value;
});
const purposeSchema = z.enum(['alumni_network', 'rehire_contact', 'alumni_events']);
const channelsSchema = z.array(z.enum(['email', 'sms', 'phone', 'wechat']))
  .min(1)
  .max(4)
  .refine((values) =>
    new Set(values).size === values.length &&
    isDeepStrictEqual(values, [...values].sort()));
const careCasePayloadBase = {
  employeeId: idSchema,
  employmentId: idSchema,
  separationType: z.enum([
    'voluntary_resignation',
    'involuntary_termination',
    'retirement',
    'contract_end',
  ]),
  reasonCode: z.string().regex(REASON_CODE_PATTERN),
  lastWorkingDate: localDateSchema,
  accessDisableAt: utcInstantSchema,
} as const;
const eventBase = {
  tenantId: idSchema,
  aggregateId: idSchema,
  version: positiveSafeIntegerSchema,
  occurredAt: utcInstantSchema,
} as const;
const cleanupPayloadBase = {
  purpose: purposeSchema,
  terminationReason: z.enum(['withdrawn', 'expired']),
  targetCode: codeSchema,
  policyVersion: codeSchema,
} as const;
const occasionTaskPayloadBase = {
  purpose: z.literal('employee_care'),
  occasionType: z.enum(['birthday', 'employment_anniversary']),
  policyVersion: codeSchema,
} as const;

const careEventSchema = z.discriminatedUnion('type', [
  careCaseEventSchema('care.case.created', 'draft'),
  careCaseEventSchema('care.case.approval_submitted', 'pending_approval'),
  careCaseEventSchema('care.case.approved', 'approved'),
  careCaseEventSchema('care.case.rejected', 'cancelled'),
  z.object({
    ...eventBase,
    type: z.literal('care.case.task_completed'),
    payload: z.object({
      ...careCasePayloadBase,
      status: z.enum(['clearing', 'ready']),
      taskCode: z.enum([
        'handover_accepted',
        'assets_cleared',
        'finance_cleared',
        'data_retention_confirmed',
      ]),
    }).strict(),
  }).strict(),
  careCaseEventSchema('care.case.scheduled', 'scheduled'),
  careCaseEventSchema('care.case.execution_started', 'executing'),
  careCaseEventSchema('care.case.completed', 'completed'),
  consentEventSchema('care.alumni_consent.granted', 'active'),
  consentEventSchema('care.alumni_consent.withdrawn', 'withdrawn'),
  consentEventSchema('care.alumni_consent.expired', 'expired'),
  cleanupEventSchema('care.alumni_cleanup.scheduled', 'pending', z.literal(0)),
  cleanupEventSchema(
    'care.alumni_cleanup.completed',
    'completed',
    nonnegativeSafeIntegerSchema.max(10_000),
  ),
  cleanupEventSchema('care.alumni_cleanup.dead', 'dead', positiveAttemptSchema),
  cleanupEventSchema('care.alumni_cleanup.replayed', 'pending', z.literal(0)),
  z.object({
    ...eventBase,
    type: z.literal('care.occasion.preference_updated'),
    payload: z.object({
      purpose: z.literal('employee_care'),
      birthdayEnabled: z.boolean(),
      anniversaryEnabled: z.boolean(),
      unsubscribed: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('care.occasion.unsubscribed'),
    payload: z.object({
      purpose: z.literal('employee_care'),
      birthdayEnabled: z.literal(false),
      anniversaryEnabled: z.literal(false),
      unsubscribed: z.literal(true),
    }).strict(),
  }).strict(),
  occasionTaskEventSchema('care.occasion.scheduled', 'pending', z.literal(0)),
  occasionTaskEventSchema('care.occasion.delivered', 'delivered', positiveAttemptSchema),
  z.object({
    ...eventBase,
    type: z.literal('care.occasion.cancelled'),
    payload: z.object({
      ...occasionTaskPayloadBase,
      status: z.literal('cancelled'),
      attempts: nonnegativeSafeIntegerSchema.max(10_000),
      denialCode: z.enum([
        'unsubscribed',
        'no_authorized_channel',
        'purpose_restricted',
        'quiet_hours',
      ]),
    }).strict(),
  }).strict(),
  occasionTaskEventSchema('care.occasion.dead', 'dead', positiveAttemptSchema),
  z.object({
    ...eventBase,
    type: z.literal('care.occasion.replayed'),
    payload: z.object({
      ...occasionTaskPayloadBase,
      status: z.literal('pending'),
      attempts: z.literal(0),
      reasonCode: z.string().regex(REPLAY_REASON_PATTERN),
    }).strict(),
  }).strict(),
]);

/** Care 可靠事件写入器；必须与业务聚合共用同一 Mongo 事务。 */
@Injectable()
export class CareOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: CarePublishedDomainEvent, session: ClientSession): Promise<void> {
    const trusted = this.requireTrustedContext();
    const canonical = assertCareEvent(event);
    if (canonical.tenantId !== trusted.tenantId) {
      throw new Error('CARE_OUTBOX_TENANT_MISMATCH');
    }
    requireActiveTransaction(session);
    const eventId = createEventId(new Date(canonical.occurredAt));
    if (!ULID_PATTERN.test(eventId)) throw new Error('CARE_OUTBOX_EVENT_ID_INVALID');
    const eventType = `cn.gaoq.erp.${canonical.type}.v1`;
    const envelope: CareCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/care-module',
      type: eventType,
      subject: `tenant/${canonical.tenantId}/care/${canonical.aggregateId}`,
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
      aggregateType: 'care' as const,
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
      throw new Error('CARE_OUTBOX_CONTEXT_INVALID');
    }
    const parsed = z.object({
      tenant: z.object({ tenantId: idSchema }).passthrough(),
      actor: z.object({
        tenantId: idSchema,
        traceId: idSchema,
      }).passthrough(),
    }).strict().safeParse(trusted);
    if (
      !parsed.success ||
      parsed.data.tenant.tenantId !== parsed.data.actor.tenantId
    ) throw new Error('CARE_OUTBOX_CONTEXT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenant.tenantId,
      traceId: parsed.data.actor.traceId,
    });
  }
}

function careCaseEventSchema<const T extends CareDomainEvent['type'], const S extends string>(
  type: T,
  status: S,
) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      ...careCasePayloadBase,
      status: z.literal(status),
    }).strict(),
  }).strict();
}

function consentEventSchema<const T extends AlumniConsentDomainEvent['type'], const S extends string>(
  type: T,
  status: S,
) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      careCaseId: idSchema,
      purpose: purposeSchema,
      channels: channelsSchema,
      status: z.literal(status),
      expiresAt: utcInstantSchema,
    }).strict(),
  }).strict();
}

function cleanupEventSchema<
  const T extends AlumniCleanupDomainEvent['type'],
  const S extends string,
>(
  type: T,
  status: S,
  attempts: z.ZodType<number>,
) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      ...cleanupPayloadBase,
      status: z.literal(status),
      attempts,
    }).strict(),
  }).strict();
}

function occasionTaskEventSchema<
  const T extends CareOccasionDomainEvent['type'],
  const S extends string,
>(
  type: T,
  status: S,
  attempts: z.ZodType<number>,
) {
  return z.object({
    ...eventBase,
    type: z.literal(type),
    payload: z.object({
      ...occasionTaskPayloadBase,
      status: z.literal(status),
      attempts,
    }).strict(),
  }).strict();
}

/** 将编译期事件收敛为无未知字段、无保留字段覆盖的运行时可信副本。 */
function assertCareEvent(value: unknown): z.infer<typeof careEventSchema> {
  const parsed = careEventSchema.safeParse(value);
  if (!parsed.success) throw new Error('CARE_OUTBOX_EVENT_INVALID');
  return deepFreeze(parsed.data);
}

function requireActiveTransaction(session: unknown): void {
  if (session === null || typeof session !== 'object') {
    throw new Error('CARE_OUTBOX_TRANSACTION_REQUIRED');
  }
  const inTransaction = (session as {
    readonly inTransaction?: () => unknown;
  }).inTransaction;
  if (typeof inTransaction !== 'function') throw new Error('CARE_OUTBOX_TRANSACTION_REQUIRED');
  let active: unknown;
  try {
    active = inTransaction.call(session) === true;
  } catch {
    throw new Error('CARE_OUTBOX_TRANSACTION_REQUIRED');
  }
  if (!active) throw new Error('CARE_OUTBOX_TRANSACTION_REQUIRED');
}

function assertCreatedRecord(
  created: unknown,
  expected: {
    readonly eventId: string;
    readonly tenantId: string;
    readonly aggregateType: 'care';
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly envelope: CareCloudEvent;
    readonly status: 'pending';
    readonly attempts: 0;
    readonly nextAttemptAt: Date;
  },
): void {
  if (!Array.isArray(created) || created.length !== 1) {
    throw new Error('CARE_OUTBOX_WRITE_UNAVAILABLE');
  }
  const result = z.object({
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
  if (!result.success) throw new Error('CARE_OUTBOX_WRITE_UNAVAILABLE');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
