import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export interface PayrollEvent {
  readonly type:
    | 'payroll.period.created'
    | 'payroll.period.collecting'
    | 'payroll.run.completed'
    | 'payroll.compensation_profile.attested'
    | 'payroll.rule_pack.attested';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  /** 事件只携带财务汇总与证据摘要，禁止员工级薪酬明细。 */
  readonly data: Readonly<Record<string, string | number | null>>;
}

@Injectable()
export class PayrollOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: PayrollEvent, session: ClientSession): Promise<void> {
    if (event.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new Error('Payroll Outbox 拒绝跨租户事件');
    }
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const envelope: CloudEvent<Record<string, unknown>> & { readonly schemaVersion: '1' } = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/payroll-module', type: eventType,
      subject: `tenant/${event.tenantId}/payroll/${event.aggregateId}`,
      time: event.occurredAt, datacontenttype: 'application/json', tenantId: event.tenantId,
      traceId: this.context.getActorRequired().traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1', data: { tenantId: event.tenantId, ...event.data },
    };
    await this.records.create([{
      eventId, tenantId: event.tenantId, aggregateType: 'payroll',
      aggregateId: event.aggregateId, aggregateVersion: event.version,
      eventType, envelope: { ...envelope }, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
    }], { session });
  }
}
