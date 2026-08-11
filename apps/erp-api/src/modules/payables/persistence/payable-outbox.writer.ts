import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import type { PayableItem } from '../domain/payable.js';

export const EVENT_TYPES = [
  'payables.item.prepared',
  'payables.item.submitted_for_approval',
  'payables.item.approved',
  'payables.treasury.materialization_requested',
  'payables.item.submitted_to_treasury',
  'payables.item.paid',
  'payables.item.failed',
  'payables.item.frozen',
] as const;

@Injectable()
export class PayableOutboxWriter {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OutboxRecord.name) private readonly records: Model<OutboxDocument>,
  ) {}

  async append(
    value: PayableItem,
    action: 'prepared' | 'submitted_for_approval' | 'approved' | 'submitted_to_treasury' |
      'paid' | 'failed' | 'frozen',
    session: ClientSession,
  ): Promise<void> {
    const domainType = `payables.item.${action}` as (typeof EVENT_TYPES)[number];
    if (!EVENT_TYPES.some((candidate) => candidate === domainType)) {
      throw new Error('PAYABLE_OUTBOX_ACTION_INVALID');
    }
    await this.write(value, domainType, {
      tenantId: value.tenantId,
      payableId: value.id,
      engagementId: value.engagementId,
      supplierId: value.supplierId,
      grossAmountMinor: value.grossAmountMinor,
      withholdingAmountMinor: value.withholdingAmountMinor,
      netAmountMinor: value.netAmountMinor,
      currency: value.currency,
      status: value.status,
      version: value.version,
      failureCode: value.failureCode,
    }, session);
  }

  /**
   * 在应付审批终态的同一事务中发布 Treasury 物化意图。
   * Treasury 必须以供应方标识解析已冻结的受控收款账户，不得从事件接收银行明文。
   */
  async appendTreasuryMaterializationRequest(
    value: PayableItem,
    session: ClientSession,
  ): Promise<void> {
    if (value.status !== 'approved' || value.approvalEvidenceRef === null) {
      throw new Error('PAYABLE_TREASURY_REQUEST_STATE_INVALID');
    }
    await this.write(value, 'payables.treasury.materialization_requested', {
      tenantId: value.tenantId,
      payableId: value.id,
      engagementId: value.engagementId,
      engagementVersion: value.engagementVersion,
      supplierId: value.supplierId,
      grossAmountMinor: value.grossAmountMinor,
      withholdingAmountMinor: value.withholdingAmountMinor,
      netAmountMinor: value.netAmountMinor,
      currency: value.currency,
      taxTreatmentCode: value.taxTreatmentCode,
      acceptanceEvidenceRef: value.acceptanceEvidenceRef,
      approvalEvidenceRef: value.approvalEvidenceRef,
      version: value.version,
    }, session);
  }

  private async write(
    value: PayableItem,
    domainType: (typeof EVENT_TYPES)[number],
    data: Readonly<Record<string, unknown>>,
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction()) throw new Error('PAYABLE_TRANSACTION_REQUIRED');
    const trusted = this.context.getRequired();
    if (value.tenantId !== trusted.tenant.tenantId) {
      throw new Error('PAYABLE_OUTBOX_TENANT_MISMATCH');
    }
    const eventId = createEventId(new Date(value.updatedAt));
    const eventType = `cn.gaoq.erp.${domainType}.v1`;
    const envelope = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/payables-module',
      type: eventType,
      subject: `tenant/${trusted.tenant.tenantId}/payable/${value.id}`,
      time: value.updatedAt, datacontenttype: 'application/json',
      tenantId: trusted.tenant.tenantId, traceId: trusted.actor.traceId,
      idempotencyKey: `${trusted.tenant.tenantId}:${eventType}:${value.id}:${value.version}`,
      schemaVersion: '1', data,
    };
    await this.records.create([{
      eventId, tenantId: trusted.tenant.tenantId, aggregateType: 'payables.item',
      aggregateId: value.id, aggregateVersion: value.version, eventType, envelope,
      status: 'pending', attempts: 0, nextAttemptAt: new Date(value.updatedAt),
    }], { session });
  }
}
