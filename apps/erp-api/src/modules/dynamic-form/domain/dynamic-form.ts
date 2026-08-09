import { BadRequestException } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { z } from 'zod';

export const FORM_FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'money_minor', 'percentage', 'boolean',
  'date', 'datetime', 'time', 'email', 'phone', 'url', 'single_select',
  'multi_select', 'radio', 'checkbox_group', 'employee', 'department',
  'attachment', 'relation_single', 'relation_multiple', 'related_property',
] as const;
export type FormFieldType = typeof FORM_FIELD_TYPES[number];

export const FORM_LAYOUT_TYPES = ['section', 'description', 'divider'] as const;
export type FormLayoutType = typeof FORM_LAYOUT_TYPES[number];
export type FormSensitivity = 'L1' | 'L2' | 'L3' | 'L4';
export type FormWidth = 'full' | 'half';

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MINOR = /^-?(0|[1-9][0-9]{0,17})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const optionSchema = z.object({
  value: z.string().min(1).max(128).regex(/^[^<>\u0000-\u001F]+$/),
  label: z.string().trim().min(1).max(128),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}).strict();

const relationSchema = z.object({
  targetFormId: z.string().regex(ULID_PATTERN),
  displayFieldKey: z.string().regex(KEY),
  filterFieldKey: z.string().regex(KEY).optional(),
  allowCreate: z.boolean().default(false),
}).strict();

const relatedPropertySchema = z.object({
  relationFieldKey: z.string().regex(KEY),
  targetFieldKey: z.string().regex(KEY),
}).strict();

const attachmentSchema = z.object({
  maxCount: z.number().int().min(1).max(20),
  maxSizeMb: z.number().int().min(1).max(50),
  accept: z.array(z.enum(['image', 'document', 'spreadsheet', 'archive', 'pdf'])).min(1).max(5),
}).strict();

const fieldSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  key: z.string().regex(KEY),
  label: z.string().trim().min(1).max(128),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean(),
  sensitivity: z.enum(['L1', 'L2', 'L3', 'L4']),
  width: z.enum(['full', 'half']),
  description: z.string().trim().max(500).default(''),
  placeholder: z.string().trim().max(128).default(''),
  options: z.array(optionSchema).min(1).max(200).optional(),
  attachment: attachmentSchema.optional(),
  relation: relationSchema.optional(),
  relatedProperty: relatedPropertySchema.optional(),
}).strict();

const layoutSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  type: z.enum(FORM_LAYOUT_TYPES),
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1_000).default(''),
}).strict();

const conditionSchema = z.object({
  field: z.string().regex(KEY),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty']),
  value: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]).optional(),
}).strict().superRefine((condition, context) => {
  if (condition.op === 'is_empty' ? condition.value !== undefined : condition.value === undefined) {
    context.addIssue({ code: 'custom', path: ['value'], message: '审批条件操作符与值不匹配' });
  }
});

const resolverSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initiator_manager') }).strict(),
  z.object({ type: z.literal('roles'), roleCodes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).min(1).max(50), scope: z.enum(['tenant', 'initiator_department']) }).strict(),
  z.object({ type: z.literal('employees'), employeeIds: z.array(z.string().regex(ACTOR_ID)).min(1).max(100) }).strict(),
  z.object({ type: z.literal('department_manager'), departmentField: z.string().regex(KEY) }).strict(),
]);

const workflowSchema = z.object({
  riskLevel: z.enum(['R1', 'R2']),
  nodes: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    name: z.string().trim().min(1).max(128),
    type: z.enum(['approval', 'copy']),
    approvalMode: z.enum(['all', 'any']).optional(),
    resolver: resolverSchema,
    condition: conditionSchema.optional(),
  }).strict()).max(50),
}).strict().superRefine((workflow, context) => {
  if (new Set(workflow.nodes.map((node) => node.id)).size !== workflow.nodes.length) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: '审批节点标识不得重复' });
  }
  for (const [index, node] of workflow.nodes.entries()) {
    if ((node.type === 'approval') !== (node.approvalMode !== undefined)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'approvalMode'], message: '审批节点必须配置会签方式，抄送节点不能配置' });
    }
  }
});

export const formDefinitionInputSchema = z.object({
  code: z.string().regex(CODE),
  name: z.string().trim().min(2).max(128),
  description: z.string().trim().max(500).default(''),
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('field'), field: fieldSchema }).strict(),
    z.object({ kind: z.literal('layout'), layout: layoutSchema }).strict(),
  ])).min(1).max(200),
  workflow: workflowSchema.optional(),
}).strict().superRefine((definition, context) => {
  const fields = definition.items.flatMap((item) => item.kind === 'field' ? [item.field] : []);
  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '字段键不得重复' });
  }
  const allowed = new Set(keys);
  for (const [index, node] of (definition.workflow?.nodes ?? []).entries()) {
    if (node.condition !== undefined && !allowed.has(node.condition.field)) {
      context.addIssue({ code: 'custom', path: ['workflow', 'nodes', index, 'condition', 'field'], message: '审批条件只能引用当前表单字段' });
    }
    if (node.resolver.type === 'department_manager') {
      const departmentField = node.resolver.departmentField;
      const department = fields.find((field) => field.key === departmentField);
      if (department?.type !== 'department') context.addIssue({ code: 'custom', path: ['workflow', 'nodes', index, 'resolver', 'departmentField'], message: '部门负责人只能引用部门字段' });
    }
  }
  for (const [index, field] of fields.entries()) {
    const path = ['items', index, 'field'] as const;
    const choice = ['single_select', 'multi_select', 'radio', 'checkbox_group'].includes(field.type);
    if (choice !== (field.options !== undefined)) {
      context.addIssue({ code: 'custom', path: [...path, 'options'], message: '选择字段必须且只能配置选项' });
    }
    if ((field.type === 'attachment') !== (field.attachment !== undefined)) {
      context.addIssue({ code: 'custom', path: [...path, 'attachment'], message: '附件字段必须且只能配置附件策略' });
    }
    const relation = field.type === 'relation_single' || field.type === 'relation_multiple';
    if (relation !== (field.relation !== undefined)) {
      context.addIssue({ code: 'custom', path: [...path, 'relation'], message: '关联字段必须且只能配置目标表单' });
    }
    if ((field.type === 'related_property') !== (field.relatedProperty !== undefined)) {
      context.addIssue({ code: 'custom', path: [...path, 'relatedProperty'], message: '关联属性必须且只能配置取值路径' });
    }
    if (field.type === 'related_property' && field.required) {
      context.addIssue({ code: 'custom', path: [...path, 'required'], message: '关联属性为只读实时值，不能设为必填' });
    }
    if (/token|secret|password|authorization/iu.test(field.key)) {
      context.addIssue({ code: 'custom', path: [...path, 'key'], message: '字段键不得使用凭据类保留字' });
    }
  }
});

export type FormDefinitionInput = z.infer<typeof formDefinitionInputSchema>;
export type DynamicFormItem = FormDefinitionInput['items'][number];
export type DynamicFormField = Extract<DynamicFormItem, { kind: 'field' }>['field'];

export interface DynamicFormDefinition extends FormDefinitionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly status: 'draft' | 'published' | 'retired';
  readonly revision: number;
  readonly version: number;
  readonly createdByActorId: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DynamicFormRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly formId: string;
  readonly formRevision: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdByActorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 解析并深冻结表单定义，隔离 HTTP、MCP 与持久化边界的可变对象。 */
export function parseFormDefinitionInput(value: unknown): FormDefinitionInput {
  const parsed = formDefinitionInputSchema.safeParse(value);
  if (!parsed.success) throw invalid('FORM_DEFINITION_INVALID', '表单定义不合法');
  return deepFreeze(structuredClone(parsed.data));
}

/** 校验记录值；关联属性为实时只读投影，不允许客户端写入。 */
export function parseRecordValues(
  input: unknown,
  definition: DynamicFormDefinition,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string')) {
    throw invalid('FORM_RECORD_VALUES_INVALID', '表单数据必须为普通 JSON 对象');
  }
  const source = input as Readonly<Record<string, unknown>>;
  const fields = definition.items.flatMap((item) => item.kind === 'field' ? [item.field] : []);
  const writable = new Map(fields.filter((field) => field.type !== 'related_property').map((field) => [field.key, field]));
  if (Object.keys(source).some((key) => !writable.has(key))) {
    throw invalid('FORM_RECORD_VALUES_INVALID', '表单数据包含未知或只读字段');
  }
  const result: Record<string, unknown> = {};
  for (const field of writable.values()) {
    const value = source[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw invalid('FORM_RECORD_REQUIRED', `字段“${field.label}”不能为空`);
      continue;
    }
    result[field.key] = parseFieldValue(field, value);
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > 512 * 1_024) {
    throw invalid('FORM_RECORD_TOO_LARGE', '单条表单数据不得超过 512 KiB');
  }
  return deepFreeze(result);
}

/** 从已验证记录中提取关联边，用于反向关联列表和目标完整性校验。 */
export function relationEdges(
  definition: DynamicFormDefinition,
  values: Readonly<Record<string, unknown>>,
): readonly { readonly fieldKey: string; readonly targetFormId: string; readonly targetRecordId: string }[] {
  const result: { fieldKey: string; targetFormId: string; targetRecordId: string }[] = [];
  for (const item of definition.items) {
    if (item.kind !== 'field' || item.field.relation === undefined) continue;
    const value = values[item.field.key];
    const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    for (const targetRecordId of ids) {
      result.push({ fieldKey: item.field.key, targetFormId: item.field.relation.targetFormId, targetRecordId });
    }
  }
  return Object.freeze(result.map((edge) => Object.freeze(edge)));
}

function parseFieldValue(field: DynamicFormField, value: unknown): unknown {
  switch (field.type) {
    case 'short_text': case 'long_text': case 'email': case 'phone': case 'url':
      return textValue(field, value);
    case 'number': case 'percentage':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e15) break;
      return value;
    case 'money_minor':
      if (typeof value === 'string' && MINOR.test(value)) return value;
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'date':
      if (typeof value === 'string' && validDate(value)) return value;
      break;
    case 'datetime':
      if (typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value) return value;
      break;
    case 'time':
      if (typeof value === 'string' && TIME.test(value)) return value;
      break;
    case 'single_select': case 'radio':
      if (typeof value === 'string' && field.options?.some((option) => option.value === value)) return value;
      break;
    case 'multi_select': case 'checkbox_group': {
      if (Array.isArray(value) && value.length <= 200 && new Set(value).size === value.length &&
        value.every((entry) => typeof entry === 'string' && field.options?.some((option) => option.value === entry))) return Object.freeze([...value]);
      break;
    }
    case 'employee': case 'department': case 'relation_single':
      if (typeof value === 'string' && (field.type === 'relation_single' ? ULID_PATTERN : ACTOR_ID).test(value)) return value;
      break;
    case 'relation_multiple': case 'attachment': {
      const max = field.type === 'attachment' ? field.attachment?.maxCount ?? 20 : 100;
      if (Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((entry) => typeof entry === 'string' && ULID_PATTERN.test(entry))) return Object.freeze([...value]);
      break;
    }
    case 'related_property':
      break;
  }
  throw invalid('FORM_FIELD_VALUE_INVALID', `字段“${field.label}”的值不合法`);
}

function textValue(field: DynamicFormField, value: unknown): string {
  const max = field.type === 'long_text' ? 20_000 : 2_000;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw invalid('FORM_FIELD_VALUE_INVALID', `字段“${field.label}”的值不合法`);
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) throw invalid('FORM_FIELD_VALUE_INVALID', `字段“${field.label}”的值不合法`);
  if (field.type === 'url') {
    try { if (new URL(value).protocol !== 'https:') throw new Error('scheme'); } catch { throw invalid('FORM_FIELD_VALUE_INVALID', `字段“${field.label}”的值不合法`); }
  }
  return value;
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
