import { describe, expect, it } from 'vitest';

import { planBaseAutomations } from './base-automation-interpreter.js';
import { parseMultidimensionalBaseInput, type MultidimensionalBase } from './multidimensional-base.js';

const BASE_ID = '01K00000000000000000000001';
const TABLE_ID = '01K00000000000000000000002';
const RECORD_ID = '01K00000000000000000000003';

function base(): MultidimensionalBase {
  const input = parseMultidimensionalBaseInput({
    code: 'projects', name: '项目管理', tables: [{ kind: 'native', formId: TABLE_ID, name: '项目', primaryFieldKey: 'name', position: 0 }],
    views: [{ id: '01K00000000000000000000004', tableId: TABLE_ID, name: '全部', type: 'grid', config: { visibleFieldKeys: ['name', 'score'], frozenFieldCount: 1, rowHeight: 'medium', sorts: [], groups: [] } }],
    automations: [{
      id: '01K00000000000000000000005', name: '高分项目审批', enabled: true,
      trigger: { type: 'record_updated', tableId: TABLE_ID, watchedFieldKeys: ['score'] },
      conditions: { mode: 'all', items: [{ fieldKey: 'score', operator: 'gte', value: 90 }] },
      actions: [{ type: 'start_approval' }],
    }],
  });
  return Object.freeze({ ...input, id: BASE_ID, tenantId: 'tenant-001', version: 2, createdByActorId: 'actor-001', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' });
}

describe('Base 自动化解释器', () => {
  it('只为命中监听字段和条件的记录事件生成无正文计划', () => {
    const event = { type: 'record_updated' as const, tableId: TABLE_ID, recordId: RECORD_ID, recordVersion: 3, values: { name: 'A', score: 95 }, changedFieldKeys: ['score'], occurredAt: '2026-08-10T00:00:00.000Z' };
    const plans = planBaseAutomations(base(), event);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ automationName: '高分项目审批', sourceRecordVersion: 3, actions: [{ type: 'start_approval' }] });
    expect(plans[0]?.planHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(plans[0])).not.toContain('95');
  });

  it('监听字段未变化或条件不满足时不生成计划', () => {
    const common = { type: 'record_updated' as const, tableId: TABLE_ID, recordId: RECORD_ID, recordVersion: 3, occurredAt: '2026-08-10T00:00:00.000Z' };
    expect(planBaseAutomations(base(), { ...common, values: { score: 95 }, changedFieldKeys: ['name'] })).toEqual([]);
    expect(planBaseAutomations(base(), { ...common, values: { score: 89 }, changedFieldKeys: ['score'] })).toEqual([]);
  });
});
