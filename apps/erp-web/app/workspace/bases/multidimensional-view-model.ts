import type { BaseField, BaseFilterCondition, BaseRecordRow, BaseView } from './multidimensional-base-types';

/** 应用视图的筛选、搜索与稳定多字段排序；仅处理已通过服务端字段权限的投影。 */
export function applyView(records: readonly BaseRecordRow[], view: BaseView | null, search: string): readonly BaseRecordRow[] {
  const keyword = search.trim().toLocaleLowerCase('zh-CN');
  const conditions = view?.config.filter?.conditions ?? [];
  const mode = view?.config.filter?.mode ?? 'all';
  const filtered = records.filter((row) => {
    const matchesKeyword = keyword === '' || Object.values(row.values).some((value) => cellText(value).toLocaleLowerCase('zh-CN').includes(keyword));
    if (!matchesKeyword) return false;
    if (conditions.length === 0) return true;
    const decisions = conditions.map((condition) => matchCondition(row.values[condition.fieldKey], condition));
    return mode === 'all' ? decisions.every(Boolean) : decisions.some(Boolean);
  });
  const sorts = view?.config.sorts ?? [];
  return Object.freeze(filtered.map((row, index) => ({ row, index })).toSorted((left, right) => {
    for (const sort of sorts) {
      const comparison = compare(left.row.values[sort.fieldKey], right.row.values[sort.fieldKey]);
      if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison;
    }
    return left.index - right.index;
  }).map(({ row }) => row));
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(cellText).join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return '[结构化数据]';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  return '—';
}

export function pickField(fields: readonly BaseField[], preferredTypes: readonly string[], labelPattern?: RegExp): BaseField | null {
  return fields.find((field) => labelPattern?.test(field.label) === true)
    ?? fields.find((field) => preferredTypes.includes(field.type))
    ?? null;
}

export function groupByField(records: readonly BaseRecordRow[], field: BaseField | null): ReadonlyMap<string, readonly BaseRecordRow[]> {
  const groups = new Map<string, BaseRecordRow[]>();
  for (const row of records) {
    const keys = field === null ? ['未分组'] : valuesForGroup(row.values[field.key]);
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return new Map([...groups.entries()].map(([key, rows]) => [key, Object.freeze(rows)]));
}

function valuesForGroup(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    const values = value.map(cellText).filter((item) => item !== '—');
    return values.length === 0 ? ['未分组'] : values;
  }
  const text = cellText(value);
  return [text === '—' ? '未分组' : text];
}

function matchCondition(value: unknown, condition: BaseFilterCondition): boolean {
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (condition.operator === 'is_empty') return empty;
  if (condition.operator === 'is_not_empty') return !empty;
  const left = cellText(value).toLocaleLowerCase('zh-CN');
  const right = cellText(condition.value).toLocaleLowerCase('zh-CN');
  if (condition.operator === 'contains') return left.includes(right);
  if (condition.operator === 'not_contains') return !left.includes(right);
  const comparison = compare(value, condition.value);
  if (condition.operator === 'eq') return comparison === 0;
  if (condition.operator === 'ne') return comparison !== 0;
  if (condition.operator === 'gt') return comparison > 0;
  if (condition.operator === 'gte') return comparison >= 0;
  if (condition.operator === 'lt') return comparison < 0;
  if (condition.operator === 'lte') return comparison <= 0;
  return false;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return cellText(left).localeCompare(cellText(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
}
