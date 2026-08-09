import { describe, expect, it } from 'vitest';

import type { BaseField, BaseRecordRow, BaseView } from './multidimensional-base-types';
import { applyView, cellText, groupByField, pickField } from './multidimensional-view-model';

const records: readonly BaseRecordRow[] = [
  { id: '1', version: 1, updatedAt: '2026-08-01T00:00:00.000Z', values: { name: '林晨', stage: '面试中', score: 92 } },
  { id: '2', version: 1, updatedAt: '2026-08-02T00:00:00.000Z', values: { name: '周悦', stage: '简历筛选', score: 84 } },
  { id: '3', version: 1, updatedAt: '2026-08-03T00:00:00.000Z', values: { name: '陆可', stage: '面试中', score: 88 } },
];

const view: BaseView = {
  id: '01K00000000000000000000001', tableId: '01K00000000000000000000002', name: '高分候选人', type: 'grid',
  config: { visibleFieldKeys: [], frozenFieldCount: 1, rowHeight: 'medium', groups: ['stage'], sorts: [{ fieldKey: 'score', direction: 'desc' }], filter: { mode: 'all', conditions: [{ fieldKey: 'score', operator: 'gte', value: 88 }] } },
};

describe('多维视图模型', () => {
  it('组合筛选、搜索与稳定排序', () => {
    expect(applyView(records, view, '').map((row) => row.id)).toEqual(['1', '3']);
    expect(applyView(records, view, '陆').map((row) => row.id)).toEqual(['3']);
  });

  it('按字段分组并保留每个分组记录', () => {
    const field: BaseField = { key: 'stage', label: '招聘阶段', type: 'single_select', sensitivity: 'L1' };
    expect([...groupByField(records, field).entries()].map(([key, rows]) => [key, rows.length])).toEqual([['面试中', 2], ['简历筛选', 1]]);
  });

  it('选择优先字段并安全格式化值', () => {
    const fields: readonly BaseField[] = [{ key: 'date', label: '面试日期', type: 'date', sensitivity: 'L1' }];
    expect(pickField(fields, ['date'], /时间|日期/u)?.key).toBe('date');
    expect(cellText(['A', 'B'])).toBe('A、B');
    expect(cellText({ hidden: true })).toBe('[结构化数据]');
  });
});
