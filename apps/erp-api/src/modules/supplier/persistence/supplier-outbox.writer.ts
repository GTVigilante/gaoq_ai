import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { SupplierRelationship } from '../domain/supplier.js';

export const EVENT_TYPES = [
  'supplier.relationship.created', 'supplier.relationship.updated', 'supplier.relationship.submitted',
  'supplier.relationship.activated', 'supplier.relationship.rejected', 'supplier.relationship.suspended',
  'supplier.relationship.reactivated', 'supplier.relationship.closed',
  'supplier.capabilities.updated', 'supplier.rates.updated',
  'supplier.qualification.expiring', 'supplier.qualification.expired',
] as const;

/** 供应方状态与目录事件；信封只携带低敏控制事实。 */
@Injectable()
export class SupplierOutboxWriter {
  constructor(private readonly context: TenantContextService, @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>) {}

  async append(supplier: SupplierRelationship, action: string, session: ClientSession): Promise<void> {
    if (!session.inTransaction()) throw new Error('SUPPLIER_TRANSACTION_REQUIRED');
    const trusted = this.context.getRequired(); const eventId = createEventId(new Date(supplier.updatedAt));
    if (!EVENT_TYPES.includes(`supplier.relationship.${action}` as (typeof EVENT_TYPES)[number])) throw new Error('SUPPLIER_OUTBOX_ACTION_INVALID');
    const eventType = `cn.gaoq.erp.supplier.relationship.${action}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/supplier-module', type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/supplier/${supplier.id}`, time: supplier.updatedAt,
      datacontenttype: 'application/json', tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${supplier.id}:${supplier.version}`,
      schemaVersion: '1', data: {
        tenantId: trusted.tenant.tenantId, supplierId: supplier.id, supplierNumber: supplier.supplierNumber,
        version: supplier.version, status: supplier.status, partyKind: supplier.partyKind,
        legalForm: supplier.legalForm, riskTier: supplier.riskTier,
        responsibleDepartmentId: supplier.responsibleDepartmentId,
        serviceCategoryCodes: supplier.capabilities.map((item) => item.serviceCategoryCode),
        statusReasonCode: supplier.statusReasonCode,
      },
    };
    await this.records.create([{ eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'supplier.relationship', aggregateId: supplier.id, aggregateVersion: supplier.version, eventType, envelope, status: 'pending', attempts: 0, nextAttemptAt: new Date(supplier.updatedAt) }], { session });
  }

  async appendCatalog(supplier: SupplierRelationship, action: 'capabilities.updated' | 'rates.updated', session: ClientSession): Promise<void> {
    if (!session.inTransaction()) throw new Error('SUPPLIER_TRANSACTION_REQUIRED');
    const trusted = this.context.getRequired(); const eventId = createEventId(new Date(supplier.updatedAt));
    const eventType = `cn.gaoq.erp.supplier.${action}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/supplier-module', type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/supplier/${supplier.id}`, time: supplier.updatedAt,
      datacontenttype: 'application/json', tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${supplier.id}:${supplier.version}`,
      schemaVersion: '1', data: {
        tenantId: trusted.tenant.tenantId, supplierId: supplier.id, version: supplier.version,
        status: supplier.status, serviceCategoryCodes: supplier.capabilities.map((item) => item.serviceCategoryCode),
      },
    };
    await this.records.create([{ eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'supplier.relationship', aggregateId: supplier.id, aggregateVersion: supplier.version, eventType, envelope, status: 'pending', attempts: 0, nextAttemptAt: new Date(supplier.updatedAt) }], { session });
  }

  async appendQualification(
    supplier: SupplierRelationship,
    action: 'expiring' | 'expired',
    effectiveOn: string,
    sourceCodes: readonly string[],
    scanDay: string,
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction()) throw new Error('SUPPLIER_TRANSACTION_REQUIRED');
    const trusted = this.context.getRequired(); const eventId = createEventId();
    const eventType = `cn.gaoq.erp.supplier.qualification.${action}.v1`;
    const now = new Date().toISOString();
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/supplier-module', type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/supplier/${supplier.id}`, time: now,
      datacontenttype: 'application/json', tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${supplier.id}:${effectiveOn}:${scanDay}`,
      schemaVersion: '1', data: {
        tenantId: trusted.tenant.tenantId, supplierId: supplier.id, version: supplier.version,
        status: supplier.status, effectiveOn, sourceCodes: [...sourceCodes],
      },
    };
    await this.records.create([{ eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'supplier.relationship', aggregateId: supplier.id, aggregateVersion: supplier.version, eventType, envelope, status: 'pending', attempts: 0, nextAttemptAt: new Date(now) }], { session });
  }
}
