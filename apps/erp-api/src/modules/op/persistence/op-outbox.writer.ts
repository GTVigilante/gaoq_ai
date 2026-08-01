import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export interface OpOperatingSummaryEvent {
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly data: {
    readonly summaryDate: string;
    readonly revision: number;
    readonly currency: 'CNY';
    readonly gmvMinor: number;
    readonly paidOrderCount: number;
    readonly refundMinor: number;
    readonly refundOrderCount: number;
    readonly activeCustomerCount: number;
    readonly payloadHash: string;
  };
}

/** OP 经营摘要只发布固定白名单控制事件，禁止动态维度和原始请求进入 Outbox。 */
@Injectable()
export class OpOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async appendOperatingSummary(
    event: OpOperatingSummaryEvent,
    session: ClientSession,
  ): Promise<void> {
    if (event.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new Error('OP_OUTBOX_CROSS_TENANT_DENIED');
    }
    this.assertEvent(event);
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = 'cn.gaoq.erp.op.operating_summary.published.v1';
    const envelope: CloudEvent<Record<string, unknown>> & { readonly schemaVersion: '1' } = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/op-module', type: eventType,
      subject: `tenant/${event.tenantId}/op/operating-summary/${event.aggregateId}`,
      time: event.occurredAt, datacontenttype: 'application/json', tenantId: event.tenantId,
      traceId: this.context.getActorRequired().traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1', data: { tenantId: event.tenantId, ...event.data },
    };
    await this.records.create([{
      eventId, tenantId: event.tenantId, aggregateType: 'op.operating_summary',
      aggregateId: event.aggregateId, aggregateVersion: event.version,
      eventType, envelope: { ...envelope }, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
    }], { session });
  }

  private assertEvent(event: OpOperatingSummaryEvent): void {
    const data = event.data;
    if (Object.keys(data).sort().join(',') !==
      'activeCustomerCount,currency,gmvMinor,paidOrderCount,payloadHash,refundMinor,refundOrderCount,revision,summaryDate' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.tenantId) ||
      !ULID_PATTERN.test(event.aggregateId) ||
      !Number.isSafeInteger(event.version) || event.version < 1 ||
      event.version !== data.revision ||
      Number.isNaN(Date.parse(event.occurredAt)) ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.payloadHash) || data.currency !== 'CNY' ||
      !isRealDate(data.summaryDate) ||
      !Number.isSafeInteger(data.revision) || data.revision < 1 ||
      ![data.gmvMinor, data.paidOrderCount, data.refundMinor, data.refundOrderCount,
        data.activeCustomerCount].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('OP_OPERATING_SUMMARY_OUTBOX_DATA_INVALID');
    }
  }
}

const isRealDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
