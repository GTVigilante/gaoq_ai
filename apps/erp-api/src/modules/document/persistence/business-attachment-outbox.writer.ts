import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { BusinessAttachmentRecord } from './business-attachment.schemas.js';

/** Worker 侧系统事件写入器；负载不得包含对象地址、checksum、来源附件 ID 或文件名。 */
@Injectable()
export class BusinessAttachmentOutboxWriter {
  constructor(@InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>) {}

  async migrated(
    record: BusinessAttachmentRecord,
    runId: string,
    occurredAt: Date,
    session: ClientSession,
  ): Promise<void> {
    const eventId = createEventId(occurredAt);
    const eventType = 'cn.gaoq.erp.business.attachment.migrated.v1';
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/document-module',
      type: eventType, subject: `tenant/${record.tenantId}/business.attachment/${record.id}`,
      time: occurredAt.toISOString(), datacontenttype: 'application/json',
      tenantId: record.tenantId, traceId: runId,
      idempotencyKey: `${record.tenantId}:${eventType}:${record.id}:2`, schemaVersion: '1',
      data: {
        tenantId: record.tenantId, aggregateId: record.id, version: 2,
        ownerType: record.ownerType, ownerId: record.ownerId,
        purpose: record.purpose, status: 'available',
      },
    };
    await this.records.create([{
      eventId, tenantId: record.tenantId, aggregateType: 'business.attachment',
      aggregateId: record.id, aggregateVersion: 2, eventType, envelope,
      status: 'pending', attempts: 0, nextAttemptAt: occurredAt,
    }], { session });
  }
}
