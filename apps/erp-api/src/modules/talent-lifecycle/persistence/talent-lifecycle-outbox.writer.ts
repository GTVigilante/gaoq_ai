import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OutboxRecord,
  type OutboxDocument,
} from '../../org/persistence/outbox.schema.js';
import type { TalentTouchpoint } from '../domain/index.js';

@Injectable()
export class TalentLifecycleOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    touchpoint: TalentTouchpoint,
    action: 'created' | 'completed' | 'cancelled',
    session: ClientSession,
  ): Promise<void> {
    const trusted = this.context.getRequired();
    if (touchpoint.tenantId !== trusted.tenant.tenantId) {
      throw new Error('人才全周期 Outbox 拒绝跨租户事件');
    }
    const occurredAt = touchpoint.updatedAt;
    const eventId = createEventId(new Date(occurredAt));
    const eventType = `cn.gaoq.erp.talent.touchpoint.${action}.v1`;
    const envelope = {
      specversion: '1.0',
      id: eventId,
      source: '//gaoq-erp/talent-lifecycle-module',
      type: eventType,
      subject: `tenant/${touchpoint.tenantId}/talent/touchpoints/${touchpoint.id}`,
      time: occurredAt,
      datacontenttype: 'application/json',
      tenantId: touchpoint.tenantId,
      traceId: trusted.actor.traceId,
      idempotencyKey:
        `${touchpoint.tenantId}:${eventType}:${touchpoint.id}:${touchpoint.version}`,
      schemaVersion: '1',
      data: {
        tenantId: touchpoint.tenantId,
        aggregateId: touchpoint.id,
        version: touchpoint.version,
        candidateId: touchpoint.candidateId,
        kind: touchpoint.kind,
        channel: touchpoint.channel,
        outcome: touchpoint.outcome,
        status: touchpoint.status,
        occurredAt: touchpoint.occurredAt,
        nextActionAt: touchpoint.nextActionAt,
      },
    };
    await this.records.create([{
      eventId,
      tenantId: touchpoint.tenantId,
      aggregateType: 'talent.touchpoint',
      aggregateId: touchpoint.id,
      aggregateVersion: touchpoint.version,
      eventType,
      envelope,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(occurredAt),
    }], { session });
  }
}
