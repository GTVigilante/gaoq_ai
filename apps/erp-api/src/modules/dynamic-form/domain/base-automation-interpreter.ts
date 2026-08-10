import { createHash } from 'node:crypto';

import type { MultidimensionalAutomationAction, MultidimensionalAutomationCondition, MultidimensionalBase } from './multidimensional-base.js';

export interface AutomationRecordEvent {
  readonly type: 'record_created' | 'record_updated';
  readonly tableId: string;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly changedFieldKeys: readonly string[];
  readonly occurredAt: string;
}

export interface AutomationExecutionPlan {
  readonly baseId: string;
  readonly baseVersion: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly sourceTableId: string;
  readonly sourceRecordId: string;
  readonly sourceRecordVersion: number;
  readonly triggerType: 'record_created' | 'record_updated';
  readonly actions: readonly MultidimensionalAutomationAction[];
  readonly planHash: string;
  readonly occurredAt: string;
}

/** 解释 Base 自动化定义；只产出控制面计划，不复制记录正文或直接执行副作用。 */
export function planBaseAutomations(
  base: MultidimensionalBase,
  event: AutomationRecordEvent,
): readonly AutomationExecutionPlan[] {
  const plans: AutomationExecutionPlan[] = [];
  for (const automation of base.automations) {
    if (!automation.enabled || automation.trigger.type !== event.type || automation.trigger.tableId !== event.tableId) continue;
    if (automation.trigger.type === 'record_updated' && automation.trigger.watchedFieldKeys.length > 0 &&
      !automation.trigger.watchedFieldKeys.some((key) => event.changedFieldKeys.includes(key))) continue;
    if (automation.conditions !== undefined) {
      const outcomes = automation.conditions.items.map((condition) => evaluateCondition(condition, event.values));
      if (automation.conditions.mode === 'all' ? outcomes.some((value) => !value) : outcomes.every((value) => !value)) continue;
    }
    const identity = {
      baseId: base.id, baseVersion: base.version, automationId: automation.id,
      sourceTableId: event.tableId, sourceRecordId: event.recordId,
      sourceRecordVersion: event.recordVersion, triggerType: event.type,
      actions: automation.actions,
    };
    plans.push(Object.freeze({
      ...identity,
      automationName: automation.name,
      actions: Object.freeze(structuredClone(automation.actions)),
      planHash: createHash('sha256').update(canonicalJson(identity)).digest('base64url'),
      occurredAt: event.occurredAt,
    }));
  }
  return Object.freeze(plans);
}

function evaluateCondition(
  condition: MultidimensionalAutomationCondition,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const value = Object.hasOwn(values, condition.fieldKey) ? values[condition.fieldKey] : undefined;
  switch (condition.operator) {
    case 'is_empty': return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    case 'is_not_empty': return !(value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0));
    case 'eq': return value === condition.value;
    case 'ne': return value !== condition.value;
    case 'contains': return typeof value === 'string' && typeof condition.value === 'string'
      ? value.includes(condition.value)
      : Array.isArray(value) && value.includes(condition.value);
    case 'not_contains': return typeof value === 'string' && typeof condition.value === 'string'
      ? !value.includes(condition.value)
      : Array.isArray(value) && !value.includes(condition.value);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (typeof value !== 'number' || typeof condition.value !== 'number' || !Number.isFinite(value) || !Number.isFinite(condition.value)) return false;
      if (condition.operator === 'gt') return value > condition.value;
      if (condition.operator === 'gte') return value >= condition.value;
      if (condition.operator === 'lt') return value < condition.value;
      return value <= condition.value;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('BASE_AUTOMATION_PLAN_INVALID');
  return encoded;
}
