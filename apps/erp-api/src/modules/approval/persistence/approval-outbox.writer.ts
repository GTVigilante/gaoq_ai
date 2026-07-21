import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalDomainEvent } from '../domain/approval-events.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export type ApprovalCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

/** 审批可靠事件写入器；必须与聚合、动作日志共用同一 Mongo 事务。 */
@Injectable()
export class ApprovalOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: ApprovalDomainEvent, session: ClientSession): Promise<ApprovalCloudEvent> {
    const trusted = this.context.getRequired();
    if (event.tenantId !== trusted.tenant.tenantId) throw new Error('审批 Outbox 拒绝跨租户事件');
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const aggregateType = event.type.startsWith('approval_template.')
      ? 'approval.template'
      : 'approval.instance';
    const envelope: ApprovalCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/approval-module',
      type: eventType,
      subject: `tenant/${event.tenantId}/${aggregateType}/${event.aggregateId}`,
      time: event.occurredAt,
      datacontenttype: 'application/json',
      tenantId: event.tenantId,
      traceId: trusted.actor.traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1',
      data: {
        tenantId: event.tenantId,
        aggregateId: event.aggregateId,
        version: event.version,
        ...event.payload,
      },
    };
    await this.records.create([{
      eventId,
      tenantId: event.tenantId,
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.version,
      eventType,
      envelope: { ...envelope },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
    }], { session });
    return envelope;
  }
}
