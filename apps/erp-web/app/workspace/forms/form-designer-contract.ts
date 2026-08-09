export type FieldType =
  | 'short_text' | 'long_text' | 'number' | 'money_minor' | 'percentage' | 'boolean'
  | 'date' | 'datetime' | 'time' | 'email' | 'phone' | 'url'
  | 'single_select' | 'multi_select' | 'radio' | 'checkbox_group'
  | 'employee' | 'department' | 'attachment'
  | 'relation_single' | 'relation_multiple' | 'related_property';
export type LayoutType = 'section' | 'description' | 'divider';
export type Sensitivity = 'L1' | 'L2' | 'L3' | 'L4';

export interface FormOption { readonly value: string; readonly label: string; readonly color?: string }
export interface DesignerField {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly sensitivity: Sensitivity;
  readonly width: 'full' | 'half';
  readonly description: string;
  readonly placeholder: string;
  readonly options?: readonly FormOption[];
  readonly attachment?: { readonly maxCount: number; readonly maxSizeMb: number; readonly accept: readonly ('image' | 'document' | 'spreadsheet' | 'archive' | 'pdf')[] };
  readonly relation?: { readonly targetFormId: string; readonly displayFieldKey: string; readonly filterFieldKey?: string; readonly allowCreate: boolean };
  readonly relatedProperty?: { readonly relationFieldKey: string; readonly targetFieldKey: string };
}
export interface DesignerLayout { readonly id: string; readonly type: LayoutType; readonly title: string; readonly description: string }
export type DesignerItem = { readonly kind: 'field'; readonly field: DesignerField } | { readonly kind: 'layout'; readonly layout: DesignerLayout };

export type WorkflowResolver =
  | { readonly type: 'initiator_manager' }
  | { readonly type: 'roles'; readonly roleCodes: readonly string[]; readonly scope: 'tenant' | 'initiator_department' }
  | { readonly type: 'employees'; readonly employeeIds: readonly string[] }
  | { readonly type: 'department_manager'; readonly departmentField: string };
export interface WorkflowNode {
  readonly id: string;
  readonly name: string;
  readonly type: 'approval' | 'copy';
  readonly approvalMode?: 'all' | 'any';
  readonly resolver: WorkflowResolver;
  readonly condition?: { readonly field: string; readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_empty'; readonly value?: string | number | boolean | null } | undefined;
}

export interface PaletteEntry {
  readonly type: FieldType | LayoutType;
  readonly kind: 'field' | 'layout';
  readonly label: string;
  readonly group: '基础字段' | '选择与组织' | '业务与关联' | '布局组件';
  readonly hint: string;
}

export const PALETTE: readonly PaletteEntry[] = Object.freeze([
  { type: 'short_text', kind: 'field', label: '单行文本', group: '基础字段', hint: '姓名、标题、编号' },
  { type: 'long_text', kind: 'field', label: '多行文本', group: '基础字段', hint: '说明与长文本' },
  { type: 'number', kind: 'field', label: '数字', group: '基础字段', hint: '可计算数值' },
  { type: 'money_minor', kind: 'field', label: '金额', group: '基础字段', hint: '整数分保存' },
  { type: 'percentage', kind: 'field', label: '百分比', group: '基础字段', hint: '比例与完成度' },
  { type: 'date', kind: 'field', label: '日期', group: '基础字段', hint: '自然日' },
  { type: 'datetime', kind: 'field', label: '日期时间', group: '基础字段', hint: '精确到分钟' },
  { type: 'time', kind: 'field', label: '时间', group: '基础字段', hint: '每日时间点' },
  { type: 'email', kind: 'field', label: '邮箱', group: '基础字段', hint: '格式校验' },
  { type: 'phone', kind: 'field', label: '手机号', group: '基础字段', hint: '联系方式' },
  { type: 'url', kind: 'field', label: '网址', group: '基础字段', hint: '仅 HTTPS' },
  { type: 'boolean', kind: 'field', label: '开关', group: '基础字段', hint: '是 / 否' },
  { type: 'single_select', kind: 'field', label: '下拉单选', group: '选择与组织', hint: '一个选项' },
  { type: 'multi_select', kind: 'field', label: '下拉多选', group: '选择与组织', hint: '多个选项' },
  { type: 'radio', kind: 'field', label: '平铺单选', group: '选择与组织', hint: '选项全部可见' },
  { type: 'checkbox_group', kind: 'field', label: '复选框组', group: '选择与组织', hint: '多项勾选' },
  { type: 'employee', kind: 'field', label: '成员', group: '选择与组织', hint: 'ERP 员工主数据' },
  { type: 'department', kind: 'field', label: '部门', group: '选择与组织', hint: 'ERP 组织主数据' },
  { type: 'attachment', kind: 'field', label: '附件', group: '业务与关联', hint: '文件元数据引用' },
  { type: 'relation_single', kind: 'field', label: '关联记录', group: '业务与关联', hint: '关联一条记录' },
  { type: 'relation_multiple', kind: 'field', label: '关联记录（多选）', group: '业务与关联', hint: '关联多条记录' },
  { type: 'related_property', kind: 'field', label: '关联属性', group: '业务与关联', hint: '实时读取目标字段' },
  { type: 'section', kind: 'layout', label: '分组标题', group: '布局组件', hint: '组织字段语义' },
  { type: 'description', kind: 'layout', label: '说明文字', group: '布局组件', hint: '填写提示' },
  { type: 'divider', kind: 'layout', label: '分隔线', group: '布局组件', hint: '弱化区块边界' },
]);

const FIELD_LABEL = new Map(PALETTE.map((entry) => [entry.type, entry.label]));
const CHOICE_TYPES: readonly FieldType[] = ['single_select', 'multi_select', 'radio', 'checkbox_group'];

/** 从字段目录创建可编辑节点；关系目标留给属性面板显式选择。 */
export function createDesignerItem(entry: PaletteEntry, existing: readonly DesignerItem[]): DesignerItem {
  const id = createUlid();
  if (entry.kind === 'layout') return { kind: 'layout', layout: { id, type: entry.type as LayoutType, title: entry.label, description: entry.type === 'description' ? '请补充填写说明' : '' } };
  const type = entry.type as FieldType;
  const base: DesignerField = {
    id, type, key: uniqueKey(type, existing), label: FIELD_LABEL.get(type) ?? '字段', required: false,
    sensitivity: type === 'attachment' ? 'L3' : 'L1', width: 'full', description: '', placeholder: '',
    ...(CHOICE_TYPES.includes(type) ? { options: [{ value: 'option_1', label: '选项一' }, { value: 'option_2', label: '选项二' }] } : {}),
    ...(type === 'attachment' ? { attachment: { maxCount: 5, maxSizeMb: 20, accept: ['image', 'document', 'spreadsheet', 'pdf'] as const } } : {}),
    ...(type === 'relation_single' || type === 'relation_multiple' ? { relation: { targetFormId: '', displayFieldKey: '', allowCreate: false } } : {}),
    ...(type === 'related_property' ? { relatedProperty: { relationFieldKey: '', targetFieldKey: '' } } : {}),
  };
  return { kind: 'field', field: base };
}

export function moveItem(items: readonly DesignerItem[], from: number, to: number): readonly DesignerItem[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items]; const [item] = next.splice(from, 1); if (item === undefined) return items; next.splice(to, 0, item); return Object.freeze(next);
}

/** 复制组件时生成新标识；字段键不会复用，避免历史数据与 API 映射发生碰撞。 */
export function duplicateDesignerItem(item: DesignerItem, existing: readonly DesignerItem[]): DesignerItem {
  if (item.kind === 'layout') return { kind: 'layout', layout: { ...item.layout, id: createUlid(), title: `${item.layout.title} 副本` } };
  return {
    kind: 'field',
    field: {
      ...structuredClone(item.field),
      id: createUlid(),
      key: uniqueKey(item.field.key.replace(/_[0-9]+$/u, ''), existing),
      label: `${item.field.label} 副本`,
    },
  };
}

export function itemId(item: DesignerItem): string { return item.kind === 'field' ? item.field.id : item.layout.id; }

export function createUlid(now = Date.now()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Math.max(0, Math.min(now, 281_474_976_710_655));
  let prefix = '';
  for (let index = 0; index < 10; index += 1) { prefix = alphabet[time % 32] + prefix; time = Math.floor(time / 32); }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let suffix = '';
  for (let index = 0; index < 16; index += 1) suffix += alphabet[(bytes[index] ?? 0) % 32];
  return `${prefix}${suffix}`;
}

function uniqueKey(type: string, items: readonly DesignerItem[]): string {
  const root = type.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 52);
  const used = new Set(items.flatMap((item) => item.kind === 'field' ? [item.field.key] : []));
  for (let index = 1; index < 10_000; index += 1) { const candidate = `${root}_${index}`; if (!used.has(candidate)) return candidate; }
  throw new Error('FORM_FIELD_KEY_EXHAUSTED');
}
