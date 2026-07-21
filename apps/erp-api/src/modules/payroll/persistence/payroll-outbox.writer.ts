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
    | 'payroll.rule_pack.attested'
    | 'payroll.approval.requested'
    | 'payroll.approval.applied'
    | 'payroll.period.locked'
    | 'payroll.tax_filing.prepared'
    | 'payroll.tax_filing.approved'
    | 'payroll.tax_filing.submitted';
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
    this.assertTaxEvent(event);
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

  private assertTaxEvent(event: PayrollEvent): void {
    if (!event.type.startsWith('payroll.tax_filing.')) return;
    const data = event.data;
    const keys = Object.keys(data).sort().join(',');
    const base =
      typeof data['period'] === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(data['period']) &&
      safeId(data['payrollRunId']) && typeof data['contentHash'] === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(data['contentHash']) &&
      positive(data['employeeCount']) && nonnegative(data['totalTaxableEarningsMinor']) &&
      integer(data['totalWithholdingTaxMinor']);
    if (event.type === 'payroll.tax_filing.prepared') {
      if (
        keys !==
          'contentHash,employeeCount,format,objectEvidenceId,payrollRunId,period,status,totalTaxableEarningsMinor,totalWithholdingTaxMinor' ||
        !base || data['format'] !== 'CN_IIT_WITHHOLDING_MANIFEST_V1' ||
        !safeId(data['objectEvidenceId']) || data['status'] !== 'prepared'
      ) throw new Error('PAYROLL_TAX_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'payroll.tax_filing.approved') {
      if (
        keys !==
          'contentHash,employeeCount,payrollRunId,period,status,strongAuthMethod,totalTaxableEarningsMinor,totalWithholdingTaxMinor' ||
        !base || data['status'] !== 'approved' || data['strongAuthMethod'] !== 'webauthn_uv'
      ) throw new Error('PAYROLL_TAX_OUTBOX_DATA_INVALID');
      return;
    }
    if (
      keys !==
        'contentHash,employeeCount,payrollRunId,period,status,taxSubmissionEvidenceId,taxSubmissionId,totalTaxableEarningsMinor,totalWithholdingTaxMinor' ||
      !base || data['status'] !== 'submitted' ||
      !safeId(data['taxSubmissionId']) || !safeId(data['taxSubmissionEvidenceId'])
    ) throw new Error('PAYROLL_TAX_OUTBOX_DATA_INVALID');
  }
}

function safeId(value: string | number | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function integer(value: string | number | null | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function nonnegative(value: string | number | null | undefined): boolean {
  return integer(value) && Number(value) >= 0;
}

function positive(value: string | number | null | undefined): boolean {
  return integer(value) && Number(value) > 0;
}
