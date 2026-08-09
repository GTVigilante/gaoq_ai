import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

@Injectable()
export class PerformanceOutboxWriter {
  constructor(private readonly context: TenantContextService, @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>) {}
  async append(input: { aggregateType: 'template' | 'cycle' | 'assignment' | 'result'; aggregateId: string; version: number; action: string; occurredAt: string; data: Record<string, unknown> }, session: ClientSession): Promise<void> {
    const trusted = this.context.getRequired();
    const eventId = createEventId(new Date(input.occurredAt));
    const eventType = `cn.gaoq.performance.${input.aggregateType}.${input.action}.v1`;
    const envelope = { specversion: '1.0', id: eventId, source: '//gaoq-erp/performance-module', type: eventType, subject: `tenant/${trusted.tenant.tenantId}/performance/${input.aggregateType}/${input.aggregateId}`, time: input.occurredAt, datacontenttype: 'application/json', tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId, idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${input.aggregateId}:${input.version}`, schemaVersion: '1', data: { tenantId: trusted.tenant.tenantId, aggregateId: input.aggregateId, version: input.version, ...input.data } };
    await this.records.create([{ eventId, tenantId: trusted.tenant.tenantId, aggregateType: `performance.${input.aggregateType}`, aggregateId: input.aggregateId, aggregateVersion: input.version, eventType, envelope, status: 'pending', attempts: 0, nextAttemptAt: new Date(input.occurredAt) }], { session });
  }
}
