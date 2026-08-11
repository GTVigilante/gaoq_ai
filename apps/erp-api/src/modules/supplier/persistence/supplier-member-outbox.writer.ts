import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { SupplierMemberRelationship } from '../domain/supplier-member.js';

export const EVENT_TYPES = [
  'supplier.member.authorized', 'supplier.member.revoked',
] as const;

@Injectable()
export class SupplierMemberOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    member: SupplierMemberRelationship,
    action: 'authorized' | 'revoked',
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction()) throw new Error('SUPPLIER_MEMBER_TRANSACTION_REQUIRED');
    const trusted = this.context.getRequired();
    const eventId = createEventId(new Date(member.updatedAt));
    const eventType = `cn.gaoq.erp.supplier.member.${action}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/supplier-module', type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/supplier/${member.supplierId}/member/${member.id}`,
      time: member.updatedAt, datacontenttype: 'application/json',
      tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${member.id}:${member.version}`,
      schemaVersion: '1', data: {
        tenantId: trusted.tenant.tenantId, supplierId: member.supplierId,
        memberId: member.id, performerRef: member.performerRef, role: member.role,
        permissions: [...member.permissions], status: member.status, version: member.version,
      },
    };
    await this.records.create([{
      eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'supplier.member',
      aggregateId: member.id, aggregateVersion: member.version, eventType, envelope,
      status: 'pending', attempts: 0, nextAttemptAt: new Date(member.updatedAt),
    }], { session });
  }
}
