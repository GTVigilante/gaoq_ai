import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type {
  AlumniConsentDomainEvent,
  CareDomainEvent,
  CareOccasionDomainEvent,
} from '../domain/index.js';

@Injectable()
export class CareOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    event: CareDomainEvent | AlumniConsentDomainEvent | CareOccasionDomainEvent,
    session: ClientSession,
  ): Promise<void> {
    const trusted = this.context.getRequired();
    if (event.tenantId !== trusted.tenant.tenantId) throw new Error('Care Outbox 拒绝跨租户事件');
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const envelope: CloudEvent<Record<string, unknown>> & { readonly schemaVersion: '1' } = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/care-module', type: eventType,
      subject: `tenant/${event.tenantId}/care/${event.aggregateId}`,
      time: event.occurredAt, datacontenttype: 'application/json', tenantId: event.tenantId,
      traceId: trusted.actor.traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1', data: {
        tenantId: event.tenantId, aggregateId: event.aggregateId,
        version: event.version, ...event.payload,
      },
    };
    await this.records.create([{
      eventId, tenantId: event.tenantId, aggregateType: 'care', aggregateId: event.aggregateId,
      aggregateVersion: event.version, eventType, envelope: { ...envelope },
      status: 'pending', attempts: 0, nextAttemptAt: new Date(event.occurredAt),
    }], { session });
  }
}
