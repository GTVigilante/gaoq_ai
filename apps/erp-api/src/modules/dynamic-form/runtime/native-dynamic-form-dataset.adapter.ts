import { Injectable, NotFoundException } from '@nestjs/common';
import { FORM_FIELD_TYPES } from '../domain/dynamic-form.js';
import { z } from 'zod';

import { DynamicFormService } from '../application/dynamic-form.service.js';
import {
  parseDatasetSchema,
  runtimeField,
  type DatasetRecordRef,
  type DatasetRef,
  type DatasetSchema,
  type QueryDatasetRecordsInput,
} from '../domain/dataset-runtime.js';
import { DatasetAdapter, type AdapterDatasetRecord } from './dataset.adapter.js';

const catalogSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    revision: z.number().int().safe().min(1),
    fields: z.array(z.object({
      key: z.string(), label: z.string(), type: z.enum(FORM_FIELD_TYPES),
      required: z.boolean(), sensitivity: z.enum(['L1', 'L2', 'L3', 'L4']),
    }).strict()).min(1),
  }).strict()),
}).strict();

/** 原生动态表单 Adapter：复用正式应用 Module，不直接访问 MongoDB。 */
@Injectable()
export class NativeDynamicFormDatasetAdapter extends DatasetAdapter {
  readonly code = 'native.dynamic_form';
  readonly requiredScope = 'erp:forms:data:read';

  constructor(private readonly forms: DynamicFormService) { super(); }

  accepts(ref: DatasetRef): boolean { return ref.kind === 'native'; }

  async catalog(): Promise<readonly DatasetSchema[]> {
    const parsed = catalogSchema.safeParse(await this.forms.listPublishedCatalog());
    if (!parsed.success) throw new Error('NATIVE_DATASET_CATALOG_INVALID');
    return Object.freeze(parsed.data.items.flatMap((form) => {
      const fields = form.fields.map((field) => runtimeField({
        ...field, readOnly: field.type === 'related_property',
      }));
      const primary = fields.find((field) => field.availability === 'generic');
      if (primary === undefined) return [];
      return [parseDatasetSchema({
        ref: { kind: 'native', datasetId: form.id, schemaRevision: form.revision },
        name: form.name,
        primaryFieldKey: primary.key,
        fields,
        capabilities: { resolve: true, snapshot: true, query: 'none', commands: [] },
      })];
    }));
  }

  async describe(ref: DatasetRef): Promise<DatasetSchema> {
    const schema = (await this.catalog()).find((item) => sameNative(item.ref, ref));
    if (schema === undefined) throw new NotFoundException({
      code: 'NATIVE_DATASET_NOT_FOUND', message: '原生数据集不存在或修订不匹配',
    });
    return schema;
  }

  async resolve(ref: DatasetRecordRef): Promise<AdapterDatasetRecord> {
    if (ref.dataset.kind !== 'native') throw new Error('NATIVE_DATASET_REF_INVALID');
    const result = await this.forms.getRecord(ref.dataset.datasetId, ref.recordId);
    if (result.record.formRevision !== ref.dataset.schemaRevision) {
      throw new NotFoundException({ code: 'NATIVE_DATASET_REVISION_MISMATCH', message: '记录不属于请求的数据集修订' });
    }
    return Object.freeze({
      dataset: ref.dataset,
      recordId: result.record.id,
      version: String(result.record.version),
      values: result.resolvedValues,
      observedAt: result.record.updatedAt,
    });
  }

  query(input: QueryDatasetRecordsInput): Promise<readonly AdapterDatasetRecord[]> {
    void input;
    return Promise.reject(new NotFoundException({ code: 'NATIVE_DATASET_QUERY_NOT_READY', message: '原生数据集服务端查询投影尚未启用' }));
  }
}

function sameNative(left: DatasetRef, right: DatasetRef): boolean {
  return left.kind === 'native' && right.kind === 'native' &&
    left.datasetId === right.datasetId && left.schemaRevision === right.schemaRevision;
}
