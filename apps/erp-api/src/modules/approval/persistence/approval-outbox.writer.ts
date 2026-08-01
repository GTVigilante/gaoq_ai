import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalDomainEvent } from '../domain/approval-events.js';
import {
  APPROVAL_CODE_PATTERN,
  APPROVAL_ID_PATTERN,
} from '../domain/approval.validation.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export type ApprovalCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().regex(APPROVAL_ID_PATTERN);
const codeSchema = z.string().regex(APPROVAL_CODE_PATTERN);
const hashSchema = z.string().regex(HASH_PATTERN);
const utcInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});
const occurredAtSchema = utcInstantSchema.refine(
  (value) => Date.parse(value) <= Date.now(),
);
const riskSchema = z.enum(['R1', 'R2']);
const uniqueApprovalIdsSchema = z.array(idSchema).max(100).refine(
  (values) => new Set(values).size === values.length,
);
const templateDraftPayloadSchema = z.object({
  code: codeSchema,
  revision: positiveSafeIntegerSchema,
  riskLevel: riskSchema,
  definitionHash: hashSchema,
}).strict();
const templatePublishedPayloadSchema = templateDraftPayloadSchema.extend({
  approvedBy: idSchema,
}).strict();
const templateRetiredPayloadSchema = z.object({
  code: codeSchema,
  revision: positiveSafeIntegerSchema,
}).strict();
const templateMigratedPayloadSchema = z.object({
  code: codeSchema,
  revision: positiveSafeIntegerSchema,
  status: z.enum(['draft', 'published', 'retired']),
  riskLevel: riskSchema,
  definitionHash: hashSchema,
}).strict();
const legacyHistoryPayloadSchema = z.object({
  templateCode: codeSchema,
  templateRevision: positiveSafeIntegerSchema,
  outcome: z.enum(['approved', 'rejected', 'withdrawn']),
  evidenceChecksum: hashSchema,
}).strict();
const instanceDraftPayloadSchema = z.object({
  initiatorId: idSchema,
  templateCode: codeSchema,
  templateRevision: positiveSafeIntegerSchema,
  riskLevel: riskSchema,
  formDataHash: hashSchema,
}).strict();
const instanceMigratedPayloadSchema = z.object({
  status: z.enum(['draft', 'running']),
  templateCode: codeSchema,
  templateRevision: positiveSafeIntegerSchema,
  riskLevel: riskSchema,
  formDataHash: hashSchema,
  actionCount: nonnegativeSafeIntegerSchema.max(10_000),
  evidenceChecksum: hashSchema,
}).strict().refine(
  (value) => value.status === 'draft'
    ? value.actionCount === 0
    : value.actionCount > 0,
);
const actorPayloadSchema = z.object({ actorId: idSchema }).strict();
const decidedPayloadSchema = z.object({
  actorId: idSchema,
  principalApproverId: idSchema,
  delegated: z.boolean(),
  nodeId: idSchema,
  outcome: z.enum(['approved', 'rejected']),
  resultingStatus: z.enum(['running', 'approved', 'rejected']),
}).strict().refine(
  (value) =>
    value.delegated === (value.actorId !== value.principalApproverId) &&
    (
      value.outcome === 'rejected'
        ? value.resultingStatus === 'rejected'
        : value.resultingStatus !== 'rejected'
    ),
);
const transferredPayloadSchema = z.object({
  actorId: idSchema,
  nodeId: idSchema,
  fromApproverId: idSchema,
  toApproverId: idSchema,
}).strict().refine((value) => value.fromApproverId !== value.toApproverId);
const addedPayloadSchema = z.object({
  actorId: idSchema,
  nodeId: idSchema,
  approverId: idSchema,
}).strict();
const withdrawnPayloadSchema = z.object({
  actorId: idSchema,
  canceledApproverIds: uniqueApprovalIdsSchema,
}).strict();
const delegationCreatedPayloadSchema = z.object({
  principalApproverId: idSchema,
  delegateId: idSchema,
  validFrom: utcInstantSchema,
  validUntil: utcInstantSchema,
}).strict().refine(
  (value) =>
    value.principalApproverId !== value.delegateId &&
    Date.parse(value.validUntil) > Date.parse(value.validFrom) &&
    Date.parse(value.validUntil) - Date.parse(value.validFrom) <= 30 * 24 * 60 * 60 * 1_000,
);
const delegationRevokedPayloadSchema = z.object({
  principalApproverId: idSchema,
  delegateId: idSchema,
  revokedBy: idSchema,
}).strict().refine(
  (value) =>
    value.principalApproverId !== value.delegateId &&
    value.revokedBy === value.principalApproverId,
);
const eventBase = {
  tenantId: idSchema,
  aggregateId: idSchema,
  version: positiveSafeIntegerSchema,
  occurredAt: occurredAtSchema,
} as const;
const approvalEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('approval_template.draft_created'),
    payload: templateDraftPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_template.draft_updated'),
    payload: templateDraftPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_template.published'),
    payload: templatePublishedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_template.retired'),
    payload: templateRetiredPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_template.migrated'),
    payload: templateMigratedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_history.migrated'),
    payload: legacyHistoryPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.draft_created'),
    payload: instanceDraftPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.draft_updated'),
    payload: instanceDraftPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.migrated'),
    payload: instanceMigratedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.submitted'),
    payload: actorPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.decided'),
    payload: decidedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.approver_transferred'),
    payload: transferredPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.approver_added'),
    payload: addedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.withdrawn'),
    payload: withdrawnPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_instance.archived'),
    payload: actorPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_delegation.created'),
    payload: delegationCreatedPayloadSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('approval_delegation.revoked'),
    payload: delegationRevokedPayloadSchema,
  }).strict(),
]);
type ApprovalEventType = ApprovalDomainEvent['type'];
const EVENT_AGGREGATE_TYPES = Object.freeze({
  'approval_template.draft_created': 'approval.template',
  'approval_template.draft_updated': 'approval.template',
  'approval_template.published': 'approval.template',
  'approval_template.retired': 'approval.template',
  'approval_template.migrated': 'approval.template',
  'approval_history.migrated': 'approval.history',
  'approval_instance.draft_created': 'approval.instance',
  'approval_instance.draft_updated': 'approval.instance',
  'approval_instance.migrated': 'approval.instance',
  'approval_instance.submitted': 'approval.instance',
  'approval_instance.decided': 'approval.instance',
  'approval_instance.approver_transferred': 'approval.instance',
  'approval_instance.approver_added': 'approval.instance',
  'approval_instance.withdrawn': 'approval.instance',
  'approval_instance.archived': 'approval.instance',
  'approval_delegation.created': 'approval.delegation',
  'approval_delegation.revoked': 'approval.delegation',
} satisfies Record<ApprovalEventType, string>);

/** 审批可靠事件写入器；必须与聚合、动作日志共用同一 Mongo 事务。 */
@Injectable()
export class ApprovalOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: ApprovalDomainEvent, session: ClientSession): Promise<ApprovalCloudEvent> {
    const trusted = this.context.getRequired();
    const canonical = assertApprovalEvent(event);
    if (canonical.tenantId !== trusted.tenant.tenantId) {
      throw new Error('APPROVAL_OUTBOX_TENANT_MISMATCH');
    }
    const eventId = createEventId(new Date(canonical.occurredAt));
    const eventType = `cn.gaoq.erp.${canonical.type}.v1`;
    const aggregateType = EVENT_AGGREGATE_TYPES[canonical.type];
    const envelope: ApprovalCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/approval-module',
      type: eventType,
      subject: `tenant/${canonical.tenantId}/${aggregateType}/${canonical.aggregateId}`,
      time: canonical.occurredAt,
      datacontenttype: 'application/json',
      tenantId: canonical.tenantId,
      traceId: trusted.actor.traceId,
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
    await this.records.create([{
      eventId,
      tenantId: canonical.tenantId,
      aggregateType,
      aggregateId: canonical.aggregateId,
      aggregateVersion: canonical.version,
      eventType,
      envelope: { ...envelope },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(canonical.occurredAt),
    }], { session });
    return envelope;
  }
}

/** 将编译期事件收敛为无未知字段、无保留字段覆盖的运行时可信副本。 */
function assertApprovalEvent(value: unknown): ApprovalDomainEvent {
  const parsed = approvalEventSchema.safeParse(value);
  if (!parsed.success) throw new Error('APPROVAL_OUTBOX_EVENT_INVALID');
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
