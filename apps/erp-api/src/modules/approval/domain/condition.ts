import { ApprovalDomainError } from './approval.errors.js';
import { assertFieldKey } from './approval.validation.js';

export type ApprovalScalar = string | number | boolean | null;
export type ApprovalFormValue = ApprovalScalar | readonly ApprovalScalar[];
export type ApprovalFormData = Readonly<Record<string, ApprovalFormValue>>;

export type ApprovalCondition =
  | { readonly op: 'eq' | 'ne'; readonly field: string; readonly value: ApprovalFormValue }
  | { readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly field: string; readonly value: number }
  | { readonly op: 'in'; readonly field: string; readonly values: readonly ApprovalScalar[] }
  | { readonly op: 'is_empty'; readonly field: string }
  | { readonly op: 'and' | 'or'; readonly conditions: readonly ApprovalCondition[] }
  | { readonly op: 'not'; readonly condition: ApprovalCondition };

const MAX_CONDITION_DEPTH = 10;
const MAX_CONDITION_NODES = 100;
const MAX_IN_VALUES = 50;

/** 校验受限条件 AST；任何字段引用必须来自当前表单字段白名单。 */
export function validateApprovalCondition(
  condition: ApprovalCondition,
  allowedFields: ReadonlySet<string>,
): void {
  const counter = { value: 0 };
  validateNode(condition, allowedFields, 0, counter);
}

/** 解释执行受限条件 AST，不执行脚本、不解析属性路径且只读取对象自有属性。 */
export function evaluateApprovalCondition(
  condition: ApprovalCondition,
  formData: ApprovalFormData,
  allowedFields: ReadonlySet<string>,
): boolean {
  validateApprovalCondition(condition, allowedFields);
  return evaluateNode(condition, formData);
}

function validateNode(
  condition: ApprovalCondition,
  allowedFields: ReadonlySet<string>,
  depth: number,
  counter: { value: number },
): void {
  counter.value += 1;
  if (depth > MAX_CONDITION_DEPTH || counter.value > MAX_CONDITION_NODES) {
    throw new ApprovalDomainError('APPROVAL_CONDITION_TOO_COMPLEX', '审批条件超过复杂度限制');
  }
  if (!isPlainCondition(condition)) {
    throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '审批条件节点必须为纯对象');
  }
  switch (condition.op) {
    case 'and':
    case 'or':
      if (
        !isArray(condition.conditions) || condition.conditions.length < 1 ||
        condition.conditions.length > 20
      ) {
        throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '逻辑条件子项数量必须为 1..20');
      }
      for (const nested of condition.conditions) {
        validateNode(nested, allowedFields, depth + 1, counter);
      }
      return;
    case 'not':
      if (!isPlainCondition(condition.condition)) {
        throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', 'not 条件必须包含一个条件节点');
      }
      validateNode(condition.condition, allowedFields, depth + 1, counter);
      return;
    case 'in':
      assertAllowedField(condition.field, allowedFields);
      if (
        !isArray(condition.values) || condition.values.length < 1 ||
        condition.values.length > MAX_IN_VALUES
      ) {
        throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', 'in 条件值数量必须为 1..50');
      }
      for (const value of condition.values) assertScalar(value);
      return;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      assertAllowedField(condition.field, allowedFields);
      if (!Number.isFinite(condition.value)) {
        throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '数值比较必须使用有限数');
      }
      return;
    case 'eq':
    case 'ne':
      assertAllowedField(condition.field, allowedFields);
      assertFormValue(condition.value);
      return;
    case 'is_empty':
      assertAllowedField(condition.field, allowedFields);
      return;
    default:
      throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '审批条件操作符不受支持');
  }
}

function assertAllowedField(field: string, allowedFields: ReadonlySet<string>): void {
  assertFieldKey(field, 'condition.field');
  if (!allowedFields.has(field)) {
    throw new ApprovalDomainError('APPROVAL_CONDITION_FIELD_DENIED', '审批条件引用了未声明字段');
  }
}

function assertFormValue(value: ApprovalFormValue): void {
  if (isScalarArray(value)) {
    if (value.length > 200) {
      throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '条件数组不能超过 200 项');
    }
    for (const item of value) assertScalar(item);
    return;
  }
  assertScalar(value);
}

function assertScalar(value: unknown): asserts value is ApprovalScalar {
  if (
    value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  ) throw new ApprovalDomainError('APPROVAL_CONDITION_INVALID', '条件只允许 JSON 标量');
}

function evaluateNode(condition: ApprovalCondition, data: ApprovalFormData): boolean {
  switch (condition.op) {
    case 'and':
      return condition.conditions.every((item) => evaluateNode(item, data));
    case 'or':
      return condition.conditions.some((item) => evaluateNode(item, data));
    case 'not':
      return !evaluateNode(condition.condition, data);
    case 'is_empty': {
      const value = ownValue(data, condition.field);
      return value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0);
    }
    case 'in': {
      const value = ownValue(data, condition.field);
      if (isScalarArray(value)) return value.some((item) => condition.values.includes(item));
      return value !== undefined && condition.values.includes(value);
    }
    case 'eq':
      return equalFormValue(ownValue(data, condition.field), condition.value);
    case 'ne':
      return !equalFormValue(ownValue(data, condition.field), condition.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = ownValue(data, condition.field);
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (condition.op === 'gt') return value > condition.value;
      if (condition.op === 'gte') return value >= condition.value;
      if (condition.op === 'lt') return value < condition.value;
      return value <= condition.value;
    }
  }
}

function ownValue(data: ApprovalFormData, field: string): ApprovalFormValue | undefined {
  return Object.hasOwn(data, field) ? data[field] : undefined;
}

function equalFormValue(left: ApprovalFormValue | undefined, right: ApprovalFormValue): boolean {
  if (isScalarArray(left) && isScalarArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function isScalarArray(value: ApprovalFormValue | undefined): value is readonly ApprovalScalar[] {
  return Array.isArray(value);
}

function isPlainCondition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}
