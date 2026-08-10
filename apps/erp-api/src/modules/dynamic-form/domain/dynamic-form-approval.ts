import { createHash } from 'node:crypto';

import type {
  ApprovalCondition, ApprovalFormData, ApprovalFormField, ApprovalFormValue, ApprovalTemplateDefinition,
} from '../../approval/domain/index.js';
import { datasetRefKey, type DatasetEvidenceSnapshot, type DatasetField, type DatasetSchema } from './dataset-runtime.js';
import type { DynamicFormDefinition, DynamicFormField, DynamicFormRecord, FormFieldType } from './dynamic-form.js';

const MAX_APPROVAL_FIELDS = 100;
const APPROVAL_KEY_MAX = 64;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface DynamicFormApprovalCompilation {
  readonly definition: ApprovalTemplateDefinition;
  readonly nativeFields: readonly DynamicFormNativeFieldBinding[];
  readonly evidenceFields: readonly DynamicFormEvidenceFieldBinding[];
}

export interface DynamicFormNativeFieldBinding {
  readonly formFieldKey: string;
  readonly approvalFieldKey: string;
}

export interface DynamicFormEvidenceFieldBinding {
  readonly formFieldKey: string;
  readonly schema: DatasetSchema;
  readonly prefix: string;
  readonly projectedFieldKeys: readonly string[];
}

/** 把发布表单与外部 Schema 编译为审批引擎的受限、确定性契约。 */
export function compileDynamicFormApproval(
  form: DynamicFormDefinition,
  externalSchemas: readonly { readonly field: DynamicFormField; readonly schema: DatasetSchema }[],
): DynamicFormApprovalCompilation {
  if (form.workflow === undefined) throw new Error('FORM_APPROVAL_WORKFLOW_REQUIRED');
  const schemaByField = new Map(externalSchemas.map((entry) => [entry.field.key, entry.schema]));
  const fields: ApprovalFormField[] = [
    metadataField('gaoq_meta_record_id', '来源表单记录', 'text'),
    metadataField('gaoq_meta_record_version', '来源记录版本', 'number'),
    metadataField('gaoq_meta_form_revision', '来源表单修订', 'number'),
  ];
  const evidenceFields: DynamicFormEvidenceFieldBinding[] = [];
  const nativeFields: DynamicFormNativeFieldBinding[] = [];
  let externalIndex = 0;
  for (const item of form.items) {
    if (item.kind !== 'field' || item.field.type === 'related_property') continue;
    const field = item.field;
    if (field.type !== 'dataset_reference') {
      const approvalFieldKey = nativeApprovalKey(field.key);
      fields.push(approvalField(field, approvalFieldKey));
      nativeFields.push(Object.freeze({ formFieldKey: field.key, approvalFieldKey }));
      continue;
    }
    const config = field.datasetReference;
    const schema = schemaByField.get(field.key);
    if (config === undefined || schema === undefined || datasetRefKey(schema.ref) !== datasetRefKey(config.dataset)) {
      throw new Error('FORM_APPROVAL_DATASET_SCHEMA_MISSING');
    }
    externalIndex += 1;
    const prefix = `gaoq_ext_${externalIndex}_`;
    fields.push(
      metadataField(`${prefix}schema`, `${field.label} · 来源 Schema`, 'text'),
      metadataField(`${prefix}record_id`, `${field.label} · 来源记录`, 'text'),
      metadataField(`${prefix}version`, `${field.label} · 来源版本`, 'text'),
      metadataField(`${prefix}observed_at`, `${field.label} · 观察时间`, 'text'),
      metadataField(`${prefix}content_hash`, `${field.label} · 证据摘要`, 'text'),
    );
    const generic = new Map(schema.fields.filter((candidate) => candidate.availability === 'generic').map((candidate) => [candidate.key, candidate]));
    const projectedFieldKeys = [...new Set([config.displayFieldKey, ...config.snapshotFieldKeys])];
    for (const key of projectedFieldKeys) {
      const source = generic.get(key);
      if (source === undefined) throw new Error('FORM_APPROVAL_DATASET_FIELD_DENIED');
      fields.push(approvalDatasetField(prefix, field.label, source));
    }
    evidenceFields.push(Object.freeze({ formFieldKey: field.key, schema, prefix, projectedFieldKeys: Object.freeze(projectedFieldKeys) }));
  }
  if (fields.length > MAX_APPROVAL_FIELDS) throw new Error('FORM_APPROVAL_FIELD_LIMIT');
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error('FORM_APPROVAL_FIELD_KEY_COLLISION');
  const keyBySource = new Map(nativeFields.map((binding) => [binding.formFieldKey, binding.approvalFieldKey]));
  const definition: ApprovalTemplateDefinition = {
    fields: Object.freeze(fields),
    nodes: Object.freeze(form.workflow.nodes.map((node) => Object.freeze({
      id: node.id,
      name: node.name,
      type: node.type,
      ...(node.approvalMode === undefined ? {} : { approvalMode: node.approvalMode }),
      resolver: node.resolver.type === 'department_manager'
        ? { type: 'department_manager' as const, departmentField: requiredMappedKey(keyBySource, node.resolver.departmentField) }
        : structuredClone(node.resolver),
      ...(node.condition === undefined ? {} : { condition: approvalCondition(node.condition, keyBySource) }),
    }))),
  };
  return Object.freeze({ definition: deepFreeze(definition), nativeFields: Object.freeze(nativeFields), evidenceFields: Object.freeze(evidenceFields) });
}

/** 将表单记录与已固定外部证据转换成审批标量，不允许审批时再次实时取值。 */
export function compileDynamicFormApprovalData(
  form: DynamicFormDefinition,
  record: DynamicFormRecord,
  compilation: DynamicFormApprovalCompilation,
  snapshots: Readonly<Record<string, DatasetEvidenceSnapshot>>,
): ApprovalFormData {
  const values: Record<string, ApprovalFormValue> = {
    gaoq_meta_record_id: record.id,
    gaoq_meta_record_version: record.version,
    gaoq_meta_form_revision: record.formRevision,
  };
  const fields = new Map(form.items.flatMap((item) => item.kind === 'field' ? [[item.field.key, item.field] as const] : []));
  for (const binding of compilation.nativeFields) {
    const field = fields.get(binding.formFieldKey);
    if (field === undefined || field.type === 'related_property' || field.type === 'dataset_reference') throw new Error('FORM_APPROVAL_NATIVE_FIELD_MISSING');
    const value = record.values[binding.formFieldKey];
    if (value !== undefined) values[binding.approvalFieldKey] = approvalValue(field.type, value);
  }
  for (const binding of compilation.evidenceFields) {
    const snapshot = snapshots[binding.formFieldKey];
    if (snapshot === undefined || datasetRefKey(snapshot.schema) !== datasetRefKey(binding.schema.ref)) {
      throw new Error('FORM_APPROVAL_EVIDENCE_MISSING');
    }
    values[`${binding.prefix}schema`] = datasetRefKey(snapshot.schema);
    values[`${binding.prefix}record_id`] = snapshot.recordId;
    values[`${binding.prefix}version`] = snapshot.recordVersion;
    values[`${binding.prefix}observed_at`] = snapshot.observedAt;
    values[`${binding.prefix}content_hash`] = snapshot.contentHash;
    const fields = new Map(binding.schema.fields.map((field) => [field.key, field]));
    for (const key of binding.projectedFieldKeys) {
      const value = snapshot.values[key];
      if (value === undefined) continue;
      const source = fields.get(key);
      if (source === undefined) throw new Error('FORM_APPROVAL_EVIDENCE_FIELD_MISSING');
      values[approvalKey(binding.prefix, key)] = approvalValue(source.type, value);
    }
  }
  return deepFreeze(values);
}

/** 同一表单记录版本总是得到同一审批 ULID，重试不会产生重复流程。 */
export function dynamicFormApprovalInstanceId(formId: string, recordId: string, recordVersion: number): string {
  const digest = createHash('sha256').update(`${formId}:${recordId}:${recordVersion}`).digest().subarray(0, 10);
  let bits = 0;
  let available = 0;
  let suffix = '';
  for (const byte of digest) {
    bits = (bits << 8) | byte;
    available += 8;
    while (available >= 5) {
      available -= 5;
      suffix += ULID_ALPHABET[(bits >>> available) & 31];
    }
    bits &= (1 << available) - 1;
  }
  return `${recordId.slice(0, 10)}${suffix}`;
}

export function dynamicFormApprovalTemplateCode(formCode: string): string {
  const suffix = '.approval';
  if (`${formCode}${suffix}`.length <= APPROVAL_KEY_MAX) return `${formCode}${suffix}`;
  const digest = createHash('sha256').update(formCode).digest('hex').slice(0, 8);
  return `${formCode.slice(0, APPROVAL_KEY_MAX - suffix.length - digest.length - 1)}_${digest}${suffix}`;
}

function approvalField(field: DynamicFormField, key: string): ApprovalFormField {
  const type = approvalType(field.type);
  return Object.freeze({
    key, label: field.label, type, required: field.required, sensitivity: field.sensitivity,
    ...(field.options === undefined ? {} : { options: field.options.map((option) => ({ key: option.value, label: option.label })) }),
    ...(type === 'text' ? { maximumLength: field.type === 'long_text' || field.type === 'relation_multiple' ? 10_000 : 2_000 } : {}),
  });
}

function approvalCondition(condition: NonNullable<NonNullable<DynamicFormDefinition['workflow']>['nodes'][number]['condition']>, keyBySource: ReadonlyMap<string, string>): ApprovalCondition {
  const field = requiredMappedKey(keyBySource, condition.field);
  switch (condition.op) {
    case 'is_empty':
      return Object.freeze({ op: 'is_empty', field });
    case 'gt': case 'gte': case 'lt': case 'lte':
      if (typeof condition.value !== 'number') throw new Error('FORM_APPROVAL_CONDITION_VALUE_INVALID');
      return Object.freeze({ op: condition.op, field, value: condition.value });
    case 'eq': case 'ne':
      if (condition.value === undefined) throw new Error('FORM_APPROVAL_CONDITION_VALUE_INVALID');
      return Object.freeze({ op: condition.op, field, value: condition.value });
  }
}

function approvalDatasetField(prefix: string, referenceLabel: string, source: DatasetField): ApprovalFormField {
  const type = approvalType(source.type, true);
  return Object.freeze({
    key: approvalKey(prefix, source.key),
    label: `${referenceLabel} · ${source.label}`.slice(0, 128),
    type,
    required: source.required,
    sensitivity: source.sensitivity,
    ...(type === 'text' ? { maximumLength: 10_000 } : {}),
  });
}

function metadataField(key: string, label: string, type: 'text' | 'number'): ApprovalFormField {
  return Object.freeze({ key, label, type, required: true, sensitivity: 'L1', ...(type === 'text' ? { maximumLength: 2_000 } : {}) });
}

function approvalType(type: FormFieldType, external = false): ApprovalFormField['type'] {
  if (type === 'number' || type === 'percentage') return 'number';
  if (type === 'boolean' || type === 'date' || type === 'employee' || type === 'department' || type === 'attachment') {
    return type === 'attachment' ? 'file_reference' : type;
  }
  if (!external && (type === 'single_select' || type === 'radio')) return 'single_select';
  if (!external && (type === 'multi_select' || type === 'checkbox_group')) return 'multi_select';
  return 'text';
}

function approvalValue(type: FormFieldType, value: unknown): ApprovalFormValue {
  if (type === 'relation_multiple' || type === 'dataset_reference' || type === 'related_property') return JSON.stringify(value);
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => scalar(entry)));
  return scalar(value);
}

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  return JSON.stringify(value);
}

function approvalKey(prefix: string, fieldKey: string): string {
  const safe = safeKey(fieldKey);
  const raw = `${prefix}${safe}`;
  if (raw.length <= APPROVAL_KEY_MAX) return raw;
  const digest = createHash('sha256').update(fieldKey).digest('hex').slice(0, 8);
  return `${prefix}${safe.slice(0, APPROVAL_KEY_MAX - prefix.length - digest.length - 1)}_${digest}`;
}

function nativeApprovalKey(fieldKey: string): string {
  const safe = safeKey(fieldKey);
  if (safe.length <= APPROVAL_KEY_MAX) return safe;
  const digest = createHash('sha256').update(fieldKey).digest('hex').slice(0, 8);
  return `${safe.slice(0, APPROVAL_KEY_MAX - digest.length - 1)}_${digest}`;
}

function safeKey(fieldKey: string): string {
  return fieldKey.replace(/[A-Z]/gu, (value, offset: number) => `${offset === 0 ? '' : '_'}${value.toLowerCase()}`);
}

function requiredMappedKey(keys: ReadonlyMap<string, string>, source: string): string {
  const key = keys.get(source);
  if (key === undefined) throw new Error('FORM_APPROVAL_FIELD_MAPPING_MISSING');
  return key;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
