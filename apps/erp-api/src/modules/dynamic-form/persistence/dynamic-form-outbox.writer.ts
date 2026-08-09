import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

const EVENT_TYPES = [
  'dynamic_form.definition.created',
  'dynamic_form.definition.updated',
  'dynamic_form.definition.published',
  'dynamic_form.record.created',
  'dynamic_form.record.updated',
] as const;

export interface DynamicFormEventInput {
  readonly aggregateType: 'definition' | 'record';
  readonly aggregateId: string;
  readonly version: number;
  readonly action: 'created' | 'updated' | 'published';
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, string | number>>;
}

/**
 * 动态数据平台 Outbox Adapter。
 * 事件只包含控制面标识和版本，禁止携带记录值、附件引用或流程参与人。
 */
@Injectable()
export class DynamicFormOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(input: DynamicFormEventInput, session: ClientSession): Promise<void> {
    const trusted = this.context.getRequired();
    const eventId = createEventId(new Date(input.occurredAt));
    const domainType = `dynamic_form.${input.aggregateType}.${input.action}`;
    if (!EVENT_TYPES.includes(domainType as typeof EVENT_TYPES[number])) throw new Error('DYNAMIC_FORM_EVENT_TYPE_INVALID');
    const eventType = `cn.gaoq.erp.${domainType}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/dynamic-form-module', type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/dynamic-form/${input.aggregateType}/${input.aggregateId}`,
      time: input.occurredAt, datacontenttype: 'application/json', tenantId: trusted.tenant.tenantId,
      traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${input.aggregateId}:${input.version}`,
      schemaVersion: '1',
      data: { tenantId: trusted.tenant.tenantId, aggregateId: input.aggregateId, version: input.version, ...input.data },
    };
    await this.records.create([{
      eventId, tenantId: trusted.tenant.tenantId, aggregateType: `dynamic_form.${input.aggregateType}`,
      aggregateId: input.aggregateId, aggregateVersion: input.version, eventType, envelope,
      status: 'pending', attempts: 0, nextAttemptAt: new Date(input.occurredAt),
    }], { session });
  }
}
