import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export interface TreasuryEvent {
  readonly type: 'treasury.bank_account.attested';
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  /** 禁止账号、户名、清算行号、盲索引、密文或员工级金额进入事件。 */
  readonly data: Readonly<Record<string, string | number | null>>;
}

@Injectable()
export class TreasuryOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(event: TreasuryEvent, session: ClientSession): Promise<void> {
    if (event.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new Error('Treasury Outbox 拒绝跨租户事件');
    }
    this.assertSafeData(event.data);
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const envelope: CloudEvent<Record<string, unknown>> & { readonly schemaVersion: '1' } = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/treasury-module', type: eventType,
      subject: `tenant/${event.tenantId}/treasury/bank-account/${event.aggregateId}`,
      time: event.occurredAt, datacontenttype: 'application/json', tenantId: event.tenantId,
      traceId: this.context.getActorRequired().traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1', data: { tenantId: event.tenantId, ...event.data },
    };
    await this.records.create([{
      eventId, tenantId: event.tenantId, aggregateType: 'treasury_bank_account',
      aggregateId: event.aggregateId, aggregateVersion: event.version,
      eventType, envelope: { ...envelope }, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
    }], { session });
  }

  private assertSafeData(data: TreasuryEvent['data']): void {
    if (
      Object.keys(data).sort().join(',') !== 'ownerId,ownerType,status,version' ||
      !['organization', 'employee'].includes(String(data['ownerType'])) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(data['ownerId'])) ||
      data['status'] !== 'active' || !Number.isSafeInteger(data['version']) ||
      Number(data['version']) < 1
    ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
  }
}
