import {
  parseApprovalSummaries,
  type ApprovalFormFieldView,
  type ApprovalPublishedTemplateForm,
  type ApprovalSummary,
} from './approval-contract';

export interface ApprovalCreateInput {
  readonly templateCode: string;
  readonly title: string;
  readonly formData: Readonly<Record<string, unknown>>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

/** 按已发布模板白名单归一化发起入参；未知字段不会进入请求。 */
export function buildApprovalCreateInput(
  value: unknown,
  selected: ApprovalPublishedTemplateForm | null,
): ApprovalCreateInput {
  if (selected === null || !isPlainObject(value)) throw invalidInput();
  if (value.templateCode !== selected.code || typeof value.title !== 'string') throw invalidInput();
  const title = value.title.trim();
  if (title.length < 1 || title.length > 256) throw invalidInput();
  const raw: Readonly<Record<string, unknown>> = isPlainObject(value.formData)
    ? value.formData
    : Object.freeze({});
  const formData: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of selected.fields) {
    const normalized = normalizeFieldValue(field, raw[field.key]);
    if (normalized !== undefined) formData[field.key] = normalized;
  }
  return Object.freeze({
    templateCode: selected.code,
    title,
    formData: Object.freeze({ ...formData }),
  });
}

/** 解析创建草稿的最小响应，不信任服务端额外字段。 */
export function parseCreatedApprovalInstance(value: unknown): ApprovalSummary {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'instance')) {
    throw new Error('APPROVAL_INSTANCE_RESPONSE_INVALID');
  }
  if (!isPlainObject(value.instance) || Object.hasOwn(value.instance, 'tenantId')) {
    throw new Error('APPROVAL_INSTANCE_RESPONSE_INVALID');
  }
  const instance = parseApprovalSummaries([value.instance])[0];
  if (instance === undefined || instance.status !== 'draft' || instance.submittedAt !== null || instance.completedAt !== null) {
    throw new Error('APPROVAL_INSTANCE_RESPONSE_INVALID');
  }
  return instance;
}

function normalizeFieldValue(field: ApprovalFormFieldView, value: unknown): unknown {
  const missing = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (missing) {
    if (field.required) throw invalidInput();
    return undefined;
  }
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string' || value.length > (field.maximumLength ?? 10_000)) throw invalidInput();
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput();
      return value;
    case 'money_minor':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidInput();
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidInput();
      return value;
    case 'date':
      if (typeof value !== 'string' || !validDate(value)) throw invalidInput();
      return value;
    case 'single_select':
      if (typeof value !== 'string' || !optionKeys(field).has(value)) throw invalidInput();
      return value;
    case 'multi_select': {
      if (!Array.isArray(value) || value.length > 200 || value.some((item) => typeof item !== 'string')) throw invalidInput();
      const unique = [...new Set(value as string[])];
      if (unique.length !== value.length || unique.some((item) => !optionKeys(field).has(item))) throw invalidInput();
      return Object.freeze(unique);
    }
    case 'employee':
    case 'department':
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalidInput();
      return value;
    case 'file_reference': {
      const references = Array.isArray(value)
        ? value
        : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
      if (
        references.length > 20 || references.some((item) => typeof item !== 'string' || !ID_PATTERN.test(item)) ||
        new Set(references).size !== references.length
      ) throw invalidInput();
      if (field.required && references.length === 0) throw invalidInput();
      return references.length === 0 ? undefined : Object.freeze([...(references as string[])]);
    }
  }
}

function optionKeys(field: ApprovalFormFieldView): ReadonlySet<string> {
  return new Set((field.options ?? []).map((option) => option.key));
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(): Error {
  return new Error('APPROVAL_CREATE_INPUT_INVALID');
}
