import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OrgDomainEvent } from '../domain/org-events.js';
import { OutboxRecord, type OutboxDocument } from './outbox.schema.js';

export type OrgCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

@Injectable()
export class OrgOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  /** 领域事件必须与聚合写入共用同一个 Mongo ClientSession。 */
  async append(event: OrgDomainEvent, session: ClientSession): Promise<OrgCloudEvent> {
    const trusted = this.context.getRequired();
    if (event.tenantId !== trusted.tenant.tenantId) {
      throw new Error('Outbox 拒绝跨租户领域事件');
    }
    const aggregateType = event.type.split('.')[0] ?? 'unknown';
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const envelope: OrgCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/org-module',
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
    const storedEnvelope: Record<string, unknown> = { ...envelope };
    await this.records.create(
      [{
        eventId,
        tenantId: event.tenantId,
        aggregateType: `org.${aggregateType}`,
        aggregateId: event.aggregateId,
        aggregateVersion: event.version,
        eventType,
        envelope: storedEnvelope,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(event.occurredAt),
      }],
      { session },
    );
    return envelope;
  }
}
