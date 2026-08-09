import { BadRequestException } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { z } from 'zod';

export const BASE_VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery', 'gantt', 'form', 'dashboard'] as const;
const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SCALAR = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);

const filterCondition = z.object({
  fieldKey: z.string().regex(FIELD_KEY),
  operator: z.enum(['eq', 'ne', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']),
  value: SCALAR.optional(),
}).strict().superRefine((value, context) => {
  const unary = value.operator === 'is_empty' || value.operator === 'is_not_empty';
  if (unary === (value.value !== undefined)) context.addIssue({ code: 'custom', path: ['value'], message: '筛选操作符与值不匹配' });
});

const viewSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  tableId: z.string().regex(ULID_PATTERN),
  name: z.string().trim().min(1).max(128),
  type: z.enum(BASE_VIEW_TYPES),
  config: z.object({
    visibleFieldKeys: z.array(z.string().regex(FIELD_KEY)).max(100),
    frozenFieldCount: z.number().int().min(0).max(5).default(1),
    rowHeight: z.enum(['compact', 'medium', 'tall']).default('medium'),
    sorts: z.array(z.object({ fieldKey: z.string().regex(FIELD_KEY), direction: z.enum(['asc', 'desc']) }).strict()).max(10).default([]),
    groups: z.array(z.string().regex(FIELD_KEY)).max(3).default([]),
    filter: z.object({ mode: z.enum(['all', 'any']), conditions: z.array(filterCondition).max(20) }).strict().optional(),
  }).strict(),
}).strict();

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), channel: z.enum(['in_app', 'email']), recipientFieldKey: z.string().regex(FIELD_KEY).optional(), templateCode: z.string().regex(CODE) }).strict(),
  z.object({ type: z.literal('create_record'), targetTableId: z.string().regex(ULID_PATTERN), fieldMapping: z.record(z.string().regex(FIELD_KEY), z.string().regex(FIELD_KEY)).refine((value) => Object.keys(value).length <= 50) }).strict(),
  z.object({ type: z.literal('update_record'), fieldMapping: z.record(z.string().regex(FIELD_KEY), z.string().regex(FIELD_KEY)).refine((value) => Object.keys(value).length <= 50) }).strict(),
  z.object({ type: z.literal('start_approval') }).strict(),
  z.object({ type: z.literal('connector_call'), connectorId: z.string().regex(CODE), operation: z.string().regex(CODE) }).strict(),
]);

const automationSchema = z.object({
  id: z.string().regex(ULID_PATTERN),
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('record_created'), tableId: z.string().regex(ULID_PATTERN) }).strict(),
    z.object({ type: z.literal('record_updated'), tableId: z.string().regex(ULID_PATTERN), watchedFieldKeys: z.array(z.string().regex(FIELD_KEY)).max(50).default([]) }).strict(),
    z.object({ type: z.literal('scheduled'), tableId: z.string().regex(ULID_PATTERN), intervalMinutes: z.number().int().min(5).max(10_080) }).strict(),
    z.object({ type: z.literal('webhook'), tableId: z.string().regex(ULID_PATTERN), webhookCode: z.string().regex(CODE) }).strict(),
    z.object({ type: z.literal('manual'), tableId: z.string().regex(ULID_PATTERN) }).strict(),
  ]),
  conditions: z.object({ mode: z.enum(['all', 'any']), items: z.array(filterCondition).max(20) }).strict().optional(),
  actions: z.array(actionSchema).min(1).max(20),
}).strict();

export const multidimensionalBaseInputSchema = z.object({
  code: z.string().regex(CODE),
  name: z.string().trim().min(2).max(128),
  description: z.string().trim().max(500).default(''),
  tables: z.array(z.object({ formId: z.string().regex(ULID_PATTERN), name: z.string().trim().min(1).max(128), primaryFieldKey: z.string().regex(FIELD_KEY), position: z.number().int().min(0).max(999) }).strict()).min(1).max(100),
  views: z.array(viewSchema).min(1).max(500),
  automations: z.array(automationSchema).max(100).default([]),
}).strict().superRefine((base, context) => {
  const tableIds = base.tables.map((table) => table.formId);
  if (new Set(tableIds).size !== tableIds.length) context.addIssue({ code: 'custom', path: ['tables'], message: '数据表不得重复' });
  if (new Set(base.views.map((view) => view.id)).size !== base.views.length) context.addIssue({ code: 'custom', path: ['views'], message: '视图标识不得重复' });
  if (new Set(base.automations.map((automation) => automation.id)).size !== base.automations.length) context.addIssue({ code: 'custom', path: ['automations'], message: '自动化标识不得重复' });
  const allowed = new Set(tableIds);
  for (const [index, view] of base.views.entries()) if (!allowed.has(view.tableId)) context.addIssue({ code: 'custom', path: ['views', index, 'tableId'], message: '视图必须属于当前 Base 的数据表' });
  for (const [index, automation] of base.automations.entries()) {
    if (!allowed.has(automation.trigger.tableId)) context.addIssue({ code: 'custom', path: ['automations', index, 'trigger', 'tableId'], message: '自动化触发器必须属于当前 Base' });
    for (const [actionIndex, action] of automation.actions.entries()) if (action.type === 'create_record' && !allowed.has(action.targetTableId)) context.addIssue({ code: 'custom', path: ['automations', index, 'actions', actionIndex, 'targetTableId'], message: '自动化目标表必须属于当前 Base' });
  }
});

export type MultidimensionalBaseInput = z.infer<typeof multidimensionalBaseInputSchema>;
export interface MultidimensionalBase extends MultidimensionalBaseInput {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly createdByActorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 解析并深冻结 Base、View 与 Automation 控制面定义。 */
export function parseMultidimensionalBaseInput(value: unknown): MultidimensionalBaseInput {
  const parsed = multidimensionalBaseInputSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'BASE_DEFINITION_INVALID', message: '多维表格定义不合法' });
  return freeze(structuredClone(parsed.data));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
