import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CloudEvent } from '@gaoq/shared-types';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';

export interface TreasuryEvent {
  readonly type:
    | 'treasury.bank_account.attested'
    | 'treasury.bank_account.migrated'
    | 'treasury.disbursement.materialization_requested'
    | 'treasury.disbursement.prepared'
    | 'treasury.disbursement.export_approved'
    | 'treasury.disbursement.submission_requested'
    | 'treasury.disbursement.submitted'
    | 'treasury.disbursement.migrated'
    | 'treasury.disbursement.recovery_requested'
    | 'treasury.bank_return.applied'
    | 'treasury.bank_return.migrated'
    | 'treasury.reconciliation.completed'
    | 'treasury.reconciliation.migrated';
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
    this.assertSafeEvent(event);
    const eventId = createEventId(new Date(event.occurredAt));
    const eventType = `cn.gaoq.erp.${event.type}.v1`;
    const bankAccountEvent = event.type === 'treasury.bank_account.attested' ||
      event.type === 'treasury.bank_account.migrated';
    const resourceType = bankAccountEvent
      ? 'bank-account' : 'disbursement-batch';
    const envelope: CloudEvent<Record<string, unknown>> & { readonly schemaVersion: '1' } = {
      specversion: '1.0', id: eventId, source: '//gaoq-erp/treasury-module', type: eventType,
      subject: `tenant/${event.tenantId}/treasury/${resourceType}/${event.aggregateId}`,
      time: event.occurredAt, datacontenttype: 'application/json', tenantId: event.tenantId,
      traceId: this.context.getActorRequired().traceId,
      idempotencyKey: `${event.tenantId}:${eventType}:${event.aggregateId}:${event.version}`,
      schemaVersion: '1', data: { tenantId: event.tenantId, ...event.data },
    };
    await this.records.create([{
      eventId, tenantId: event.tenantId,
      aggregateType: bankAccountEvent
        ? 'treasury_bank_account' : 'treasury_disbursement_batch',
      aggregateId: event.aggregateId, aggregateVersion: event.version,
      eventType, envelope: { ...envelope }, status: 'pending', attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
    }], { session });
  }

  private assertSafeEvent(event: TreasuryEvent): void {
    const data = event.data;
    const keys = Object.keys(data).sort().join(',');
    if (event.type === 'treasury.reconciliation.completed' ||
      event.type === 'treasury.reconciliation.migrated') {
      if (
        keys !==
          'differenceCount,evidenceHash,payrollPeriodId,payrollRunId,reconciliationId,status' ||
        !safeId(data['payrollPeriodId']) || !safeId(data['payrollRunId']) ||
        !safeId(data['reconciliationId']) || !nonnegativeInteger(data['differenceCount']) ||
        typeof data['evidenceHash'] !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data['evidenceHash']) ||
        !['reconciled', 'frozen'].includes(String(data['status']))
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.bank_return.applied') {
      if (
        keys !==
          'duplicateCount,failedCount,failedMinor,freezeReason,lineAmountMismatchCount,malwareScanEvidenceId,objectEvidenceId,outcome,returnHash,signatureEvidenceId,successfulCount,successfulMinor,unknownCount' ||
        !['reconciling', 'frozen'].includes(String(data['outcome'])) ||
        typeof data['returnHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['returnHash']) ||
        !safeId(data['objectEvidenceId']) || !safeId(data['signatureEvidenceId']) ||
        !safeId(data['malwareScanEvidenceId']) ||
        !nonnegativeInteger(data['successfulCount']) || !nonnegativeInteger(data['failedCount']) ||
        !nonnegativeInteger(data['unknownCount']) || !nonnegativeInteger(data['duplicateCount']) ||
        !nonnegativeInteger(data['lineAmountMismatchCount']) ||
        !nonnegativeInteger(data['successfulMinor']) || !nonnegativeInteger(data['failedMinor']) ||
        typeof data['freezeReason'] !== 'string'
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.bank_return.migrated') {
      if (
        keys !== 'outcome,returnHash,successfulCount,successfulMinor' ||
        data['outcome'] !== 'reconciling' || typeof data['returnHash'] !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data['returnHash']) ||
        !nonnegativeInteger(data['successfulCount']) ||
        !nonnegativeInteger(data['successfulMinor'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.disbursement.recovery_requested') {
      if (
        keys !==
          'failedCount,failedMinor,parentBatchId,payrollPeriodId,payrollRunId,returnHash,status,strongAuthMethod' ||
        !safeId(data['parentBatchId']) || !safeId(data['payrollPeriodId']) ||
        !safeId(data['payrollRunId']) || !positiveInteger(data['failedCount']) ||
        !positiveInteger(data['failedMinor']) || data['status'] !== 'materializing' ||
        data['strongAuthMethod'] !== 'webauthn_uv' ||
        typeof data['returnHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['returnHash'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.bank_account.attested') {
      if (
        keys !== 'ownerId,ownerType,status,version' ||
        !['organization', 'employee'].includes(String(data['ownerType'])) ||
        !safeId(data['ownerId']) || data['status'] !== 'active' || !positiveInteger(data['version'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.bank_account.migrated') {
      if (
        keys !== 'ownerType,status,version' ||
        !['organization', 'employee'].includes(String(data['ownerType'])) ||
        !['active', 'revoked'].includes(String(data['status'])) ||
        !positiveInteger(data['version'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    const baseValid = safeId(data['payrollPeriodId']) && safeId(data['payrollRunId']) &&
      positiveInteger(data['lineCount']) && positiveInteger(data['totalMinor']);
    if (event.type === 'treasury.disbursement.materialization_requested') {
      if (
        keys !== 'lineCount,payrollPeriodId,payrollRunId,status,totalMinor' ||
        !baseValid || data['status'] !== 'materializing'
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.disbursement.export_approved') {
      if (
        keys !==
          'fileHash,lineCount,objectEvidenceId,payrollPeriodId,payrollRunId,status,strongAuthMethod,totalMinor' ||
        !baseValid || data['status'] !== 'exported' || data['strongAuthMethod'] !== 'webauthn_uv' ||
        !safeId(data['objectEvidenceId']) || typeof data['fileHash'] !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data['fileHash'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.disbursement.submitted') {
      if (
        keys !==
          'bankSubmissionEvidenceId,bankSubmissionId,fileHash,lineCount,payrollPeriodId,payrollRunId,status,totalMinor' ||
        !baseValid || data['status'] !== 'submitted' ||
        !safeId(data['bankSubmissionId']) || !safeId(data['bankSubmissionEvidenceId']) ||
        typeof data['fileHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['fileHash'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.disbursement.migrated') {
      if (
        keys !== 'fileHash,lineCount,payrollPeriodId,payrollRunId,status,totalMinor' ||
        !baseValid || data['status'] !== 'submitted' ||
        typeof data['fileHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['fileHash'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (event.type === 'treasury.disbursement.submission_requested') {
      if (
        keys !== 'fileHash,lineCount,payrollPeriodId,payrollRunId,status,totalMinor' ||
        !baseValid || data['status'] !== 'submitting' ||
        typeof data['fileHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['fileHash'])
      ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
      return;
    }
    if (
      keys !==
        'fileHash,lineCount,objectEvidenceId,payrollPeriodId,payrollRunId,status,totalMinor' ||
      !baseValid || data['status'] !== 'prepared' || !safeId(data['objectEvidenceId']) ||
      typeof data['fileHash'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data['fileHash'])
    ) throw new Error('TREASURY_OUTBOX_DATA_INVALID');
  }
}

function safeId(value: string | number | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function positiveInteger(value: string | number | null | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: string | number | null | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
