import { describe, expect, it } from 'vitest';

import { parseMultidimensionalBaseInput } from './multidimensional-base.js';

const TABLE_ID = '01J00000000000000000000001';
const VIEW_ID = '01J00000000000000000000002';

const base = () => ({
  code: 'recruitment_ops', name: '招聘运营中心', description: '',
  tables: [{ formId: TABLE_ID, name: '候选人', primaryFieldKey: 'candidate_name', position: 0 }],
  views: [{ id: VIEW_ID, tableId: TABLE_ID, name: '全部候选人', type: 'grid', config: { visibleFieldKeys: ['candidate_name'], frozenFieldCount: 1, rowHeight: 'medium', sorts: [], groups: [] } }],
  automations: [],
});

describe('多维 Base 领域约束', () => {
  it('接受复用动态表单的数据表与表格视图', () => {
    const parsed = parseMultidimensionalBaseInput(base());
    expect(parsed.tables[0]).toMatchObject({ kind: 'native', formId: TABLE_ID });
    expect(Object.isFrozen(parsed.views)).toBe(true);
  });

  it('接受绑定 Schema 版本的 OP 外部数据集', () => {
    const externalTableId = '01J00000000000000000000004';
    const input = {
      ...base(),
      tables: [{
        kind: 'external', id: externalTableId, name: 'OP 经营摘要', primaryFieldKey: 'summaryDate', position: 0,
        dataset: { kind: 'external', system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' },
      }],
      views: [{ ...base().views[0], tableId: externalTableId, config: { ...base().views[0]!.config, visibleFieldKeys: ['summaryDate'] } }],
    };
    const parsed = parseMultidimensionalBaseInput(input);
    expect(parsed.tables[0]).toMatchObject({ kind: 'external', id: externalTableId, dataset: { system: 'op', schemaVersion: '1.0' } });
  });

  it('拒绝指向 Base 外数据表的视图', () => {
    const input = base();
    input.views[0]!.tableId = '01J00000000000000000000009';
    expect(() => parseMultidimensionalBaseInput(input)).toThrow();
  });

  it('自动化连接器只能引用登记标识和操作，不接受任意 URL', () => {
    const input = { ...base(), automations: [{
      id: '01J00000000000000000000003', name: '同步招聘渠道', enabled: true,
      trigger: { type: 'record_created', tableId: TABLE_ID },
      actions: [{ type: 'connector_call', connectorId: 'recruitment', operation: 'candidate.upsert', url: 'https://evil.example' }],
    }] };
    expect(() => parseMultidimensionalBaseInput(input)).toThrow();
  });
});
