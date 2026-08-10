import { ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  buildDatasetEvidenceSnapshot, datasetRefKey, parseDatasetSchema, parseResolvedDatasetRecord,
  projectDatasetRecord,
  type DatasetEvidenceSnapshot, type DatasetSchema,
} from '../domain/dataset-runtime.js';
import type { DynamicFormDefinition, DynamicFormField } from '../domain/dynamic-form.js';
import { OpOperatingSummaryDatasetAdapter } from './op-operating-summary-dataset.adapter.js';

/** 外部记录引用运行时：发布时闭合 Schema，写记录时闭合权威记录版本。 */
@Injectable()
export class ExternalDatasetReferenceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly opOperatingSummary: OpOperatingSummaryDatasetAdapter,
  ) {}

  async validateDefinition(form: DynamicFormDefinition): Promise<void> {
    for (const { field, schema } of await this.schemas(form)) {
      const allowed = new Set(schema.fields.filter((item) => item.availability === 'generic').map((item) => item.key));
      if (!allowed.has(field.datasetReference!.displayFieldKey) || field.datasetReference!.snapshotFieldKeys.some((key) => !allowed.has(key))) {
        throw new Error('FORM_DATASET_REFERENCE_FIELD_INVALID');
      }
    }
  }

  /** 返回已授权且已反向绑定引用配置的外部 Schema，供审批编译器使用。 */
  async schemas(form: DynamicFormDefinition): Promise<readonly ExternalDatasetFieldSchema[]> {
    const result: ExternalDatasetFieldSchema[] = [];
    for (const field of referenceFields(form)) {
      const adapter = this.adapter(field.datasetReference!.dataset);
      this.scope(adapter.requiredScope);
      const schema = this.schema(await adapter.describe(field.datasetReference!.dataset), field.datasetReference!.dataset);
      result.push(Object.freeze({ field, schema }));
    }
    return Object.freeze(result);
  }

  async assertRecordReferences(form: DynamicFormDefinition, values: Readonly<Record<string, unknown>>): Promise<void> {
    for (const field of referenceFields(form)) {
      const value = values[field.key];
      if (value === undefined) continue;
      const config = field.datasetReference!;
      const adapter = this.adapter(config.dataset);
      this.scope(adapter.requiredScope);
      const schema = this.schema(await adapter.describe(config.dataset), config.dataset);
      const ref = value as { readonly dataset: typeof config.dataset; readonly recordId: string; readonly version: string };
      const resolved = parseResolvedDatasetRecord(await adapter.resolve(ref), ref, schema);
      projectDatasetRecord(resolved, schema, [config.displayFieldKey, ...config.snapshotFieldKeys]);
    }
  }

  /** 在审批提交时重新读取权威记录并固定配置字段、来源版本与内容摘要。 */
  async snapshotRecordReferences(
    form: DynamicFormDefinition,
    values: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, DatasetEvidenceSnapshot>>> {
    const result: Record<string, DatasetEvidenceSnapshot> = {};
    for (const field of referenceFields(form)) {
      const value = values[field.key];
      if (value === undefined) continue;
      const config = field.datasetReference!;
      const adapter = this.adapter(config.dataset);
      this.scope(adapter.requiredScope);
      const schema = this.schema(await adapter.describe(config.dataset), config.dataset);
      const ref = value as { readonly dataset: typeof config.dataset; readonly recordId: string; readonly version: string };
      const resolved = parseResolvedDatasetRecord(await adapter.resolve(ref), ref, schema);
      result[field.key] = buildDatasetEvidenceSnapshot(projectDatasetRecord(
        resolved, schema, [config.displayFieldKey, ...config.snapshotFieldKeys],
      ));
    }
    return Object.freeze(result);
  }

  private adapter(ref: { readonly system: string; readonly objectType: string; readonly schemaVersion: string }) {
    if (!this.opOperatingSummary.accepts({ kind: 'external', ...ref })) throw new Error('FORM_DATASET_ADAPTER_NOT_FOUND');
    return this.opOperatingSummary;
  }

  private schema(value: unknown, requested: { readonly system: string; readonly objectType: string; readonly schemaVersion: string }): DatasetSchema {
    const parsed = parseDatasetSchema(value);
    const expected = { kind: 'external' as const, ...requested };
    if (datasetRefKey(parsed.ref) !== datasetRefKey(expected)) throw new Error('FORM_DATASET_SCHEMA_REF_MISMATCH');
    return parsed;
  }

  private scope(required: string): void {
    if (!this.context.getActorRequired().scopes.includes(required)) throw new ForbiddenException({
      code: 'FORM_DATASET_SOURCE_SCOPE_REQUIRED', message: '当前身份无权引用该外部数据集',
    });
  }
}

export interface ExternalDatasetFieldSchema {
  readonly field: DynamicFormField;
  readonly schema: DatasetSchema;
}

function referenceFields(form: DynamicFormDefinition) {
  return form.items.flatMap((item) => item.kind === 'field' && item.field.type === 'dataset_reference' ? [item.field] : []);
}
