import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { FORM_FIELD_TYPES, type FormFieldType, type FormSensitivity } from './dynamic-form.js';
import {
  datasetRecordRefSchema, datasetRefSchema, sameDatasetRef,
  type DatasetRecordRef, type DatasetRef,
} from './dataset-reference.js';

export {
  datasetRecordRefSchema, datasetRefKey, datasetRefSchema, externalDatasetRefSchema,
  nativeDatasetRefSchema, parseDatasetRef, sameDatasetRef,
} from './dataset-reference.js';
export type { DatasetRecordRef, DatasetRef } from './dataset-reference.js';

const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const fieldSchema = z.object({
  key: z.string().regex(FIELD_KEY),
  label: z.string().trim().min(1).max(128),
  type: z.enum(FORM_FIELD_TYPES),
  sensitivity: z.enum(['L1', 'L2', 'L3', 'L4']),
  required: z.boolean(),
  readOnly: z.boolean(),
  availability: z.enum(['generic', 'dedicated_only']),
}).strict();

export const datasetSchemaSchema = z.object({
  ref: datasetRefSchema,
  name: z.string().trim().min(1).max(128),
  primaryFieldKey: z.string().regex(FIELD_KEY),
  fields: z.array(fieldSchema).min(1).max(200),
  capabilities: z.object({
    resolve: z.literal(true),
    snapshot: z.boolean(),
    query: z.enum(['none', 'exact']),
    commands: z.array(z.string().regex(CODE)).max(50),
  }).strict(),
}).strict().superRefine((schema, context) => {
  const keys = schema.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['fields'], message: '数据集字段键不得重复' });
  }
  const primary = schema.fields.find((field) => field.key === schema.primaryFieldKey);
  if (primary === undefined || primary.availability !== 'generic') {
    context.addIssue({ code: 'custom', path: ['primaryFieldKey'], message: '主字段必须是可通用读取字段' });
  }
});

export const resolveDatasetRecordSchema = z.object({
  record: datasetRecordRefSchema,
  fieldKeys: z.array(z.string().regex(FIELD_KEY)).max(100).optional(),
}).strict().superRefine((request, context) => {
  if (request.fieldKeys !== undefined && new Set(request.fieldKeys).size !== request.fieldKeys.length) {
    context.addIssue({ code: 'custom', path: ['fieldKeys'], message: '读取字段不得重复' });
  }
});

const queryScalar = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
export const queryDatasetRecordsSchema = z.object({
  dataset: datasetRefSchema,
  filters: z.array(z.object({
    fieldKey: z.string().regex(FIELD_KEY), operator: z.literal('eq'), value: queryScalar,
  }).strict()).min(1).max(10),
  fieldKeys: z.array(z.string().regex(FIELD_KEY)).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().superRefine((request, context) => {
  if (new Set(request.filters.map((filter) => filter.fieldKey)).size !== request.filters.length) {
    context.addIssue({ code: 'custom', path: ['filters'], message: '精确查询字段不得重复' });
  }
  if (request.fieldKeys !== undefined && new Set(request.fieldKeys).size !== request.fieldKeys.length) {
    context.addIssue({ code: 'custom', path: ['fieldKeys'], message: '读取字段不得重复' });
  }
});

export type DatasetSchema = z.infer<typeof datasetSchemaSchema>;
export type DatasetField = DatasetSchema['fields'][number];
export type ResolveDatasetRecordInput = z.infer<typeof resolveDatasetRecordSchema>;
export type QueryDatasetRecordsInput = z.infer<typeof queryDatasetRecordsSchema>;

export interface ResolvedDatasetRecord {
  readonly ref: DatasetRecordRef & { readonly version: string };
  readonly values: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export interface DatasetEvidenceSnapshot {
  readonly schema: DatasetRef;
  readonly recordId: string;
  readonly recordVersion: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly contentHash: string;
}

/** 从已验证、已投影的记录生成确定性证据；摘要覆盖来源、版本、值与观察时间。 */
export function buildDatasetEvidenceSnapshot(record: ResolvedDatasetRecord): DatasetEvidenceSnapshot {
  const payload = {
    schema: record.ref.dataset,
    recordId: record.ref.recordId,
    recordVersion: record.ref.version,
    values: record.values,
    observedAt: record.observedAt,
  };
  return freeze({
    ...payload,
    contentHash: createHash('sha256').update(canonicalJson(payload)).digest('base64url'),
  });
}

/** 解析运行时读取请求；字段投影只能使用规范字段键。 */
export function parseResolveDatasetRecord(value: unknown): ResolveDatasetRecordInput {
  const parsed = resolveDatasetRecordSchema.safeParse(value);
  if (!parsed.success) throw invalid('DATASET_RESOLVE_REQUEST_INVALID', '数据集记录读取请求不合法');
  return freeze(structuredClone(parsed.data));
}

/** 精确查询只接受声明字段上的等值条件，禁止动态操作符和任意表达式。 */
export function parseQueryDatasetRecords(value: unknown): QueryDatasetRecordsInput {
  const parsed = queryDatasetRecordsSchema.safeParse(value);
  if (!parsed.success) throw invalid('DATASET_QUERY_INVALID', '数据集精确查询不合法');
  return freeze(structuredClone(parsed.data));
}

/** 校验 Adapter 返回的 Schema，确保运行时只解释受限且版本化的元数据。 */
export function parseDatasetSchema(value: unknown): DatasetSchema {
  const parsed = datasetSchemaSchema.safeParse(value);
  if (!parsed.success) throw invalid('DATASET_SCHEMA_INVALID', '数据集 Schema 不合法');
  return freeze(structuredClone(parsed.data));
}

/** 对 Adapter 返回值执行字段类型、引用和来源版本闭包校验。 */
export function parseResolvedDatasetRecord(
  value: unknown,
  requested: DatasetRecordRef,
  schema: DatasetSchema,
): ResolvedDatasetRecord {
  if (!isPlainObject(value)) throw invalid('DATASET_RECORD_INVALID', '数据集记录必须为普通对象');
  const candidate = value;
  if (!sameDatasetRef(candidate.dataset, schema.ref) || candidate.recordId !== requested.recordId) {
    throw invalid('DATASET_RECORD_REF_MISMATCH', '数据集记录与请求引用不一致');
  }
  if (typeof candidate.version !== 'string' || !VERSION.test(candidate.version)) {
    throw invalid('DATASET_RECORD_VERSION_INVALID', '数据集记录版本不合法');
  }
  if (requested.version !== undefined && requested.version !== candidate.version) {
    throw invalid('DATASET_RECORD_VERSION_CONFLICT', '数据集记录版本已变化');
  }
  if (typeof candidate.observedAt !== 'string' || !canonicalInstant(candidate.observedAt)) {
    throw invalid('DATASET_RECORD_TIME_INVALID', '数据集记录观察时间不合法');
  }
  if (!isPlainObject(candidate.values)) throw invalid('DATASET_RECORD_VALUES_INVALID', '数据集记录值必须为普通对象');
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  const values: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(candidate.values)) {
    const field = fields.get(key);
    if (field === undefined) throw invalid('DATASET_RECORD_FIELD_UNKNOWN', '数据集记录包含未知字段');
    values[key] = parseDatasetValue(field.type, entry);
  }
  return freeze({
    ref: { dataset: schema.ref, recordId: requested.recordId, version: candidate.version },
    values,
    observedAt: candidate.observedAt,
  });
}

/** 生成通用数据集允许返回的最小字段投影；L3/L4 永久留在专用业务 Module。 */
export function projectDatasetRecord(
  record: ResolvedDatasetRecord,
  schema: DatasetSchema,
  fieldKeys?: readonly string[],
): ResolvedDatasetRecord {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  const requested = fieldKeys ?? schema.fields.filter((field) => field.availability === 'generic').map((field) => field.key);
  const values: Record<string, unknown> = {};
  for (const key of requested) {
    const field = fields.get(key);
    if (field === undefined) throw invalid('DATASET_FIELD_UNKNOWN', '请求引用了未知数据集字段');
    if (field.availability !== 'generic') throw invalid('DATASET_FIELD_DEDICATED_ONLY', '敏感字段只能由专用业务界面读取');
    if (Object.hasOwn(record.values, key)) values[key] = record.values[key];
  }
  return freeze({ ...record, values });
}

export function runtimeField(
  input: {
    readonly key: string;
    readonly label: string;
    readonly type: FormFieldType;
    readonly sensitivity: FormSensitivity;
    readonly required: boolean;
    readonly readOnly: boolean;
  },
): DatasetField {
  return freeze({
    ...input,
    availability: input.sensitivity === 'L1' || input.sensitivity === 'L2'
      ? 'generic' as const
      : 'dedicated_only' as const,
  });
}

function parseDatasetValue(type: FormFieldType, value: unknown): unknown {
  if (value === null) return null;
  if (['short_text', 'long_text', 'email', 'phone', 'url', 'date', 'datetime', 'time', 'single_select', 'radio', 'employee', 'department', 'relation_single'].includes(type)) {
    if (typeof value === 'string' && value.length <= 20_000) return value;
  } else if (type === 'number' || type === 'percentage') {
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) return value;
  } else if (type === 'money_minor') {
    if (typeof value === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(value)) return value;
  } else if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
  } else if (['multi_select', 'checkbox_group', 'attachment', 'relation_multiple', 'related_property'].includes(type)) {
    if (isDatasetScalarArray(value) && value.length <= 200) {
      return freeze(value.map((entry) => entry));
    }
    if (type === 'related_property' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) return value;
  } else if (type === 'dataset_reference') {
    const parsed = datasetRecordRefSchema.safeParse(value);
    if (parsed.success && parsed.data.version !== undefined) return freeze(structuredClone(parsed.data));
  }
  throw invalid('DATASET_FIELD_VALUE_INVALID', '数据集字段值与 Schema 类型不一致');
}

function canonicalInstant(value: string): boolean {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('DATASET_SNAPSHOT_VALUE_INVALID');
  return encoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isDatasetScalarArray(value: unknown): value is readonly (string | number | boolean | null)[] {
  return Array.isArray(value) && value.every((entry: unknown) =>
    entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
