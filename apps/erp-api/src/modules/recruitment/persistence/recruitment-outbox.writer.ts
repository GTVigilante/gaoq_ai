import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { RecruitmentDomainEvent } from '../domain/recruitment-events.js';

export type RecruitmentCloudEvent = CloudEvent<Record<string, unknown>> & {
  readonly schemaVersion: '1';
};

/** 招聘可靠事件写入器；必须与候选人、申请和授权证据共用 Mongo 事务。 */
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
    const trusted = this.context.getRequired();
    if (event.tenantId !== trusted.tenant.tenantId) {
      throw new Error('招聘 Outbox 拒绝跨租户事件');
    }
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const envelope: RecruitmentCloudEvent = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/recruitment-module',
      type: eventType,
      subject: `tenant/${event.tenantId}/${event.aggregateType}/${event.aggregateId}`,
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
      aggregateType: event.aggregateType,
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
