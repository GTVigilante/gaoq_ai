import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  datasetRefKey,
  buildDatasetEvidenceSnapshot,
  parseQueryDatasetRecords,
  parseDatasetSchema,
  parseResolveDatasetRecord,
  parseResolvedDatasetRecord,
  projectDatasetRecord,
  type DatasetEvidenceSnapshot,
  type DatasetRef,
  type DatasetSchema,
  type ResolvedDatasetRecord,
} from '../domain/dataset-runtime.js';
import { NativeDynamicFormDatasetAdapter } from './native-dynamic-form-dataset.adapter.js';
import { OpOperatingSummaryDatasetAdapter } from './op-operating-summary-dataset.adapter.js';
import type { DatasetAdapter } from './dataset.adapter.js';

/** 统一数据集运行时：集中完成 Adapter 选择、来源闭包、类型解释、敏感投影和证据摘要。 */
@Injectable()
export class DatasetRuntimeService {
  private readonly adapters: readonly DatasetAdapter[];

  constructor(
    private readonly context: TenantContextService,
    native: NativeDynamicFormDatasetAdapter,
    opOperatingSummary: OpOperatingSummaryDatasetAdapter,
  ) {
    this.adapters = Object.freeze([native, opOperatingSummary]);
  }

  async catalog(): Promise<{ readonly items: readonly DatasetSchema[] }> {
    const scopes = new Set(this.context.getActorRequired().scopes);
    const schemas: DatasetSchema[] = [];
    for (const adapter of this.adapters) {
      if (!scopes.has(adapter.requiredScope)) continue;
      for (const item of await adapter.catalog()) {
        const schema = parseDatasetSchema(item);
        if (!adapter.accepts(schema.ref)) throw new Error('DATASET_CATALOG_ADAPTER_MISMATCH');
        schemas.push(schema);
      }
    }
    const keys = schemas.map((schema) => datasetRefKey(schema.ref));
    if (new Set(keys).size !== keys.length) throw new Error('DATASET_CATALOG_DUPLICATE');
    return { items: Object.freeze(schemas) };
  }

  async describe(ref: DatasetRef): Promise<DatasetSchema> {
    const adapter = this.adapter(ref);
    this.scope(adapter.requiredScope);
    const schema = parseDatasetSchema(await adapter.describe(ref));
    if (datasetRefKey(schema.ref) !== datasetRefKey(ref)) throw new Error('DATASET_SCHEMA_REF_MISMATCH');
    return schema;
  }

  async resolve(input: unknown): Promise<ResolvedDatasetRecord> {
    const request = parseResolveDatasetRecord(input);
    const adapter = this.adapter(request.record.dataset);
    this.scope(adapter.requiredScope);
    const schema = await this.describe(request.record.dataset);
    const resolved = parseResolvedDatasetRecord(
      await adapter.resolve(request.record), request.record, schema,
    );
    return projectDatasetRecord(resolved, schema, request.fieldKeys);
  }

  async snapshot(input: unknown): Promise<DatasetEvidenceSnapshot> {
    return buildDatasetEvidenceSnapshot(await this.resolve(input));
  }

  async query(input: unknown): Promise<{ readonly schema: DatasetSchema; readonly items: readonly ResolvedDatasetRecord[] }> {
    const request = parseQueryDatasetRecords(input);
    const adapter = this.adapter(request.dataset);
    this.scope(adapter.requiredScope);
    const schema = await this.describe(request.dataset);
    if (schema.capabilities.query !== 'exact') throw new NotFoundException({
      code: 'DATASET_QUERY_UNSUPPORTED', message: '数据集未声明精确查询能力',
    });
    const fields = new Map(schema.fields.map((field) => [field.key, field]));
    for (const filter of request.filters) {
      const field = fields.get(filter.fieldKey);
      if (field === undefined || field.availability !== 'generic') throw new ForbiddenException({
        code: 'DATASET_QUERY_FIELD_DENIED', message: '查询字段不存在或不可通用查询',
      });
    }
    const raw = await adapter.query(request);
    if (raw.length > request.limit) throw new Error('DATASET_QUERY_LIMIT_EXCEEDED');
    const items = raw.map((item) => projectDatasetRecord(
      parseResolvedDatasetRecord(item, { dataset: request.dataset, recordId: item.recordId }, schema),
      schema, request.fieldKeys,
    ));
    if (new Set(items.map((item) => item.ref.recordId)).size !== items.length) throw new Error('DATASET_QUERY_RECORD_DUPLICATE');
    return { schema, items: Object.freeze(items) };
  }

  private adapter(ref: DatasetRef): DatasetAdapter {
    const matches = this.adapters.filter((adapter) => adapter.accepts(ref));
    if (matches.length !== 1) throw new NotFoundException({
      code: 'DATASET_ADAPTER_NOT_FOUND', message: '数据集来源未登记或登记冲突',
    });
    return matches[0]!;
  }

  private scope(required: string): void {
    if (!this.context.getActorRequired().scopes.includes(required)) {
      throw new ForbiddenException({ code: 'DATASET_SOURCE_SCOPE_REQUIRED', message: '当前身份无权读取该数据集来源' });
    }
  }
}
