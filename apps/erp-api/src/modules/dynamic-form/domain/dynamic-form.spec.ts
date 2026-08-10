import { describe, expect, it } from 'vitest';

import { parseFormDefinitionInput, parseRecordValues, relationEdges, type DynamicFormDefinition } from './dynamic-form.js';

const FORM_ID = '01K00000000000000000000001';
const TARGET_FORM_ID = '01K00000000000000000000002';
const TARGET_RECORD_ID = '01K00000000000000000000003';
const OP_DATASET = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };

function definition(): DynamicFormDefinition {
  const input = parseFormDefinitionInput({
    code: 'employee_change', name: '员工异动', description: '', items: [
      { kind: 'field', field: { id: '01K00000000000000000000004', key: 'title', label: '标题', type: 'short_text', required: true, sensitivity: 'L1', width: 'full', description: '', placeholder: '' } },
      { kind: 'field', field: { id: '01K00000000000000000000005', key: 'budget', label: '预算', type: 'money_minor', required: false, sensitivity: 'L3', width: 'half', description: '', placeholder: '' } },
      { kind: 'field', field: { id: '01K00000000000000000000006', key: 'project', label: '项目', type: 'relation_single', required: true, sensitivity: 'L2', width: 'half', description: '', placeholder: '', relation: { targetFormId: TARGET_FORM_ID, displayFieldKey: 'name', allowCreate: false } } },
      { kind: 'field', field: { id: '01K00000000000000000000007', key: 'project_owner', label: '项目负责人', type: 'related_property', required: false, sensitivity: 'L2', width: 'half', description: '', placeholder: '', relatedProperty: { relationFieldKey: 'project', targetFieldKey: 'owner' } } },
      { kind: 'field', field: { id: '01K00000000000000000000008', key: 'files', label: '附件', type: 'attachment', required: false, sensitivity: 'L3', width: 'full', description: '', placeholder: '', attachment: { maxCount: 2, maxSizeMb: 20, accept: ['pdf'] } } },
    ],
  });
  return Object.freeze({ ...input, id: FORM_ID, tenantId: 'tenant-001', status: 'published', revision: 1, version: 2, createdByActorId: 'employee-001', publishedAt: '2026-08-09T00:00:00.000Z', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' });
}

describe('dynamic-form domain', () => {
  it('按字段定义解析记录并提取可反向查询的关系边', () => {
    const values = parseRecordValues({ title: '华东交付', budget: '120000', project: TARGET_RECORD_ID, files: [] }, definition());
    expect(values).toEqual({ title: '华东交付', budget: '120000', project: TARGET_RECORD_ID, files: [] });
    expect(relationEdges(definition(), values)).toEqual([{ fieldKey: 'project', targetFormId: TARGET_FORM_ID, targetRecordId: TARGET_RECORD_ID }]);
    expect(Object.isFrozen(values)).toBe(true);
  });

  it('拒绝客户端写入只读关联属性和浮点金额', () => {
    expect(() => parseRecordValues({ title: '华东交付', budget: 12.5, project: TARGET_RECORD_ID }, definition())).toThrowError('字段“预算”的值不合法');
    expect(() => parseRecordValues({ title: '华东交付', project: TARGET_RECORD_ID, project_owner: 'employee-001' }, definition())).toThrowError('表单数据包含未知或只读字段');
  });

  it('拒绝凭据类字段键和不完整的附件策略', () => {
    expect(() => parseFormDefinitionInput({ code: 'unsafe', name: '危险表单', items: [{ kind: 'field', field: { id: FORM_ID, key: 'access_token', label: '访问令牌', type: 'short_text', required: false, sensitivity: 'L4', width: 'full', description: '', placeholder: '' } }] })).toThrowError('表单定义不合法');
    expect(() => parseFormDefinitionInput({ code: 'files', name: '附件表单', items: [{ kind: 'field', field: { id: FORM_ID, key: 'files', label: '附件', type: 'attachment', required: false, sensitivity: 'L3', width: 'full', description: '', placeholder: '' } }] })).toThrowError('表单定义不合法');
    expect(() => parseFormDefinitionInput({ code: 'reserved', name: '保留字段', items: [{ kind: 'field', field: { id: FORM_ID, key: 'gaoq_meta_record_id', label: '伪造来源', type: 'short_text', required: false, sensitivity: 'L1', width: 'full', description: '', placeholder: '' } }] })).toThrowError('表单定义不合法');
  });

  it('外部数据只保存已登记数据集、记录标识和固定来源版本', () => {
    const input = parseFormDefinitionInput({
      code: 'op_review', name: '经营复核', items: [{
        kind: 'field', field: {
          id: FORM_ID, key: 'summary', label: '经营摘要', type: 'dataset_reference', required: true,
          sensitivity: 'L2', width: 'full', description: '', placeholder: '',
          datasetReference: { dataset: OP_DATASET, displayFieldKey: 'summaryDate', snapshotFieldKeys: ['summaryDate', 'gmvMinor'] },
        },
      }],
    });
    const form = Object.freeze({
      ...input, id: FORM_ID, tenantId: 'tenant-001', status: 'published' as const, revision: 1, version: 2,
      createdByActorId: 'employee-001', publishedAt: '2026-08-09T00:00:00.000Z',
      createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
    });
    const reference = { dataset: OP_DATASET, recordId: '2026-08-09', version: '4' };
    expect(parseRecordValues({ summary: reference }, form)).toEqual({ summary: reference });
    expect(() => parseRecordValues({ summary: { ...reference, version: undefined } }, form)).toThrowError('字段“经营摘要”的值不合法');
    expect(() => parseRecordValues({ summary: { ...reference, dataset: { ...OP_DATASET, schemaVersion: '2.0' } } }, form)).toThrowError('字段“经营摘要”的值不合法');
  });

  it('拒绝直接把外部记录对象作为审批条件', () => {
    expect(() => parseFormDefinitionInput({
      code: 'op_review', name: '经营复核', items: [{
        kind: 'field', field: {
          id: FORM_ID, key: 'summary', label: '经营摘要', type: 'dataset_reference', required: true,
          sensitivity: 'L2', width: 'full', description: '', placeholder: '',
          datasetReference: { dataset: OP_DATASET, displayFieldKey: 'summaryDate', snapshotFieldKeys: ['gmvMinor'] },
        },
      }], workflow: { riskLevel: 'R1', nodes: [{ id: 'review', name: '复核', type: 'approval', approvalMode: 'all', resolver: { type: 'initiator_manager' }, condition: { field: 'summary', op: 'is_empty' } }] },
    })).toThrowError('表单定义不合法');
  });
});
