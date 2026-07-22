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
    | 'payroll.period.migrated'
    | 'payroll.run.migrated'
    | 'payroll.period_approval.migrated'
    | 'payroll.period_lock.migrated'
    | 'payroll.compensation_profile.attested'
    | 'payroll.rule_pack.attested'
    | 'payroll.rule_pack.migrated'
    | 'payroll.compensation_profile.migrated'
    | 'payroll.approval.requested'
    | 'payroll.approval.applied'
    | 'payroll.period.locked'
    | 'payroll.disbursement.started'
    | 'payroll.reconciliation.started'
    | 'payroll.reconciliation.completed'
    | 'payroll.tax_filing.prepared'
    | 'payroll.tax_filing.approved'
    | 'payroll.tax_filing.submitted'
    | 'payroll.shadow_cycle.compared'
    | 'payroll.shadow_difference.explained'
    | 'payroll.shadow_cycle.signed'
    | 'payroll.cutover_readiness.eligible';
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
    this.assertReconciliationEvent(event);
    this.assertShadowEvent(event);
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

  private assertReconciliationEvent(event: PayrollEvent): void {
    if (
      event.type !== 'payroll.disbursement.started' &&
      event.type !== 'payroll.reconciliation.started' &&
      event.type !== 'payroll.reconciliation.completed'
    ) return;
    const data = event.data;
    const keys = Object.keys(data).sort().join(',');
    const period = typeof data['period'] === 'string' &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(data['period']);
    if (event.type === 'payroll.disbursement.started') {
      if (
        keys !== 'batchId,period,status' || !period || !safeId(data['batchId']) ||
        data['status'] !== 'disbursing'
      ) throw new Error('PAYROLL_RECONCILIATION_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'payroll.reconciliation.started') {
      if (
        keys !== 'batchId,period,returnHash,status' || !period || !safeId(data['batchId']) ||
        typeof data['returnHash'] !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data['returnHash']) || data['status'] !== 'reconciling'
      ) throw new Error('PAYROLL_RECONCILIATION_OUTBOX_DATA_INVALID');
      return;
    }
    if (
      keys !== 'batchId,differenceCount,evidenceHash,period,reconciliationId,status' ||
      !period || !safeId(data['batchId']) || !safeId(data['reconciliationId']) ||
      typeof data['evidenceHash'] !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(data['evidenceHash']) ||
      !nonnegative(data['differenceCount']) ||
      !['reconciled', 'frozen'].includes(String(data['status']))
    ) throw new Error('PAYROLL_RECONCILIATION_OUTBOX_DATA_INVALID');
  }

  private assertShadowEvent(event: PayrollEvent): void {
    if (!event.type.startsWith('payroll.shadow_') &&
      event.type !== 'payroll.cutover_readiness.eligible') return;
    const data = event.data;
    const keys = Object.keys(data).sort().join(',');
    if (event.type === 'payroll.shadow_cycle.compared') {
      if (
        keys !== 'comparisonHash,differenceCount,erpEmployeeCount,legacyEmployeeCount,payrollRunId,period,sourceManifestHash,status,totalAbsoluteDifferenceMinor' ||
        !month(data['period']) || !safeId(data['payrollRunId']) ||
        !hash(data['comparisonHash']) || !hash(data['sourceManifestHash']) ||
        !positive(data['erpEmployeeCount']) || !positive(data['legacyEmployeeCount']) ||
        !nonnegative(data['differenceCount']) || !nonnegative(data['totalAbsoluteDifferenceMinor']) ||
        !['needs_explanation', 'ready_for_payroll_signoff'].includes(String(data['status']))
      ) throw new Error('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'payroll.shadow_difference.explained') {
      if (
        keys !== 'comparisonHash,differenceCount,explainedDifferenceCount,period,status,unresolvedDifferenceCount' ||
        !month(data['period']) || !hash(data['comparisonHash']) ||
        !nonnegative(data['differenceCount']) || !nonnegative(data['explainedDifferenceCount']) ||
        !nonnegative(data['unresolvedDifferenceCount']) ||
        Number(data['explainedDifferenceCount']) + Number(data['unresolvedDifferenceCount']) !==
          Number(data['differenceCount']) ||
        !['needs_explanation', 'ready_for_payroll_signoff'].includes(String(data['status']))
      ) throw new Error('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'payroll.shadow_cycle.signed') {
      if (
        keys !== 'comparisonHash,differenceCount,explanationSetHash,period,signoffEvidenceHash,signoffRole,status,strongAuthMethod' ||
        !month(data['period']) || !hash(data['comparisonHash']) ||
        !hash(data['explanationSetHash']) || !hash(data['signoffEvidenceHash']) ||
        !nonnegative(data['differenceCount']) ||
        !['payroll_owner', 'finance_owner'].includes(String(data['signoffRole'])) ||
        (data['signoffRole'] === 'payroll_owner'
          ? data['status'] !== 'payroll_signed' : data['status'] !== 'signed') ||
        data['strongAuthMethod'] !== 'webauthn_uv'
      ) throw new Error('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
      return;
    }
    if (
      keys !== 'endPeriod,evidenceHash,firstCycleId,secondCycleId,startPeriod,status' ||
      !month(data['startPeriod']) || !month(data['endPeriod']) ||
      !safeId(data['firstCycleId']) || !safeId(data['secondCycleId']) ||
      !hash(data['evidenceHash']) || data['status'] !== 'eligible'
    ) throw new Error('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
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

function hash(value: string | number | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function month(value: string | number | null | undefined): boolean {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
