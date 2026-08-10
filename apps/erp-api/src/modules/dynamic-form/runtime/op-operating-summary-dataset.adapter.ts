import { Injectable, NotFoundException } from '@nestjs/common';

import { OpOperatingSummaryService } from '../../op/application/op-operating-summary.service.js';
import {
  parseDatasetSchema,
  runtimeField,
  type DatasetRecordRef,
  type DatasetRef,
  type DatasetSchema,
  type QueryDatasetRecordsInput,
} from '../domain/dataset-runtime.js';
import { DatasetAdapter, type AdapterDatasetRecord } from './dataset.adapter.js';

const REF = Object.freeze({
  kind: 'external' as const,
  system: 'op',
  objectType: 'operating_summary',
  schemaVersion: '1.0',
});

/** OP 经营摘要 Adapter：OP 保持唯一事实源，运行时只接收其受控只读投影。 */
@Injectable()
export class OpOperatingSummaryDatasetAdapter extends DatasetAdapter {
  readonly code = 'external.op.operating_summary';
  readonly requiredScope = 'erp:op:operating_summary:read';
  private readonly schema = parseDatasetSchema({
    ref: REF,
    name: 'OP 每日经营摘要',
    primaryFieldKey: 'summaryDate',
    fields: [
      runtimeField({ key: 'summaryDate', label: '经营日期', type: 'date', sensitivity: 'L1', required: true, readOnly: true }),
      runtimeField({ key: 'revision', label: '修订', type: 'number', sensitivity: 'L1', required: true, readOnly: true }),
      runtimeField({ key: 'currency', label: '币种', type: 'short_text', sensitivity: 'L1', required: true, readOnly: true }),
      runtimeField({ key: 'gmvMinor', label: 'GMV（分）', type: 'money_minor', sensitivity: 'L2', required: true, readOnly: true }),
      runtimeField({ key: 'paidOrderCount', label: '支付订单数', type: 'number', sensitivity: 'L2', required: true, readOnly: true }),
      runtimeField({ key: 'refundMinor', label: '退款额（分）', type: 'money_minor', sensitivity: 'L2', required: true, readOnly: true }),
      runtimeField({ key: 'refundOrderCount', label: '退款订单数', type: 'number', sensitivity: 'L2', required: true, readOnly: true }),
      runtimeField({ key: 'activeCustomerCount', label: '活跃客户数', type: 'number', sensitivity: 'L2', required: true, readOnly: true }),
    ],
    capabilities: { resolve: true, snapshot: true, query: 'exact', commands: [] },
  });

  constructor(private readonly summaries: OpOperatingSummaryService) { super(); }

  accepts(ref: DatasetRef): boolean {
    return ref.kind === 'external' && ref.system === REF.system &&
      ref.objectType === REF.objectType && ref.schemaVersion === REF.schemaVersion;
  }

  catalog(): Promise<readonly DatasetSchema[]> { return Promise.resolve(Object.freeze([this.schema])); }

  describe(ref: DatasetRef): Promise<DatasetSchema> {
    if (!this.accepts(ref)) return Promise.reject(new NotFoundException({ code: 'OP_DATASET_NOT_FOUND', message: 'OP 数据集不存在' }));
    return Promise.resolve(this.schema);
  }

  async resolve(ref: DatasetRecordRef): Promise<AdapterDatasetRecord> {
    if (!this.accepts(ref.dataset)) throw new Error('OP_DATASET_REF_INVALID');
    const summary = await this.summaries.getLatest(ref.recordId);
    return Object.freeze({
      dataset: REF,
      recordId: summary.summaryDate,
      version: String(summary.revision),
      observedAt: new Date().toISOString(),
      values: Object.freeze({
        summaryDate: summary.summaryDate,
        revision: summary.revision,
        currency: summary.currency,
        gmvMinor: String(summary.metrics.gmvMinor),
        paidOrderCount: summary.metrics.paidOrderCount,
        refundMinor: String(summary.metrics.refundMinor),
        refundOrderCount: summary.metrics.refundOrderCount,
        activeCustomerCount: summary.metrics.activeCustomerCount,
      }),
    });
  }

  async query(input: QueryDatasetRecordsInput): Promise<readonly AdapterDatasetRecord[]> {
    if (!this.accepts(input.dataset)) throw new Error('OP_DATASET_QUERY_REF_INVALID');
    if (input.filters.length !== 1 || input.filters[0]?.fieldKey !== 'summaryDate' || typeof input.filters[0].value !== 'string') {
      throw new NotFoundException({ code: 'OP_DATASET_QUERY_UNSUPPORTED', message: 'OP 经营摘要只支持按经营日期精确查询' });
    }
    return Object.freeze([await this.resolve({ dataset: input.dataset, recordId: input.filters[0].value })]);
  }
}
