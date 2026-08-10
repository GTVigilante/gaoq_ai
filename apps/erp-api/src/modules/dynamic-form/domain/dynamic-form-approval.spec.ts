import { describe, expect, it } from 'vitest';

import { validateAndFreezeApprovalFormData, validateAndFreezeApprovalTemplateDefinition } from '../../approval/domain/index.js';
import { parseDatasetSchema, type DatasetEvidenceSnapshot } from './dataset-runtime.js';
import {
  compileDynamicFormApproval,
  compileDynamicFormApprovalData,
  dynamicFormApprovalInstanceId,
  dynamicFormApprovalTemplateCode,
} from './dynamic-form-approval.js';
import { parseFormDefinitionInput, type DynamicFormDefinition, type DynamicFormRecord } from './dynamic-form.js';

const FORM_ID = '01K00000000000000000000001';
const RECORD_ID = '01K00000000000000000000002';
const DATASET = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };
const SCHEMA = parseDatasetSchema({
  ref: DATASET, name: 'OP 每日经营摘要', primaryFieldKey: 'summaryDate',
  fields: [
    { key: 'summaryDate', label: '经营日期', type: 'date', sensitivity: 'L1', required: true, readOnly: true, availability: 'generic' },
    { key: 'gmvMinor', label: 'GMV（分）', type: 'money_minor', sensitivity: 'L2', required: true, readOnly: true, availability: 'generic' },
  ], capabilities: { resolve: true, snapshot: true, query: 'exact', commands: [] },
});

function form(): DynamicFormDefinition {
  const input = parseFormDefinitionInput({
    code: 'op_budget_review', name: '经营预算复核', items: [
      { kind: 'field', field: { id: '01K00000000000000000000003', key: 'budgetMinor', label: '预算（分）', type: 'money_minor', required: true, sensitivity: 'L2', width: 'half', description: '', placeholder: '' } },
      { kind: 'field', field: { id: '01K00000000000000000000004', key: 'summary', label: '经营摘要', type: 'dataset_reference', required: true, sensitivity: 'L2', width: 'half', description: '', placeholder: '', datasetReference: { dataset: DATASET, displayFieldKey: 'summaryDate', snapshotFieldKeys: ['gmvMinor'] } } },
    ], workflow: { riskLevel: 'R1', nodes: [{ id: 'manager_review', name: '直属上级复核', type: 'approval', approvalMode: 'all', resolver: { type: 'initiator_manager' } }] },
  });
  return Object.freeze({
    ...input, id: FORM_ID, tenantId: 'tenant-001', status: 'published', revision: 2, version: 4,
    createdByActorId: 'employee-001', publishedAt: '2026-08-10T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
}

function record(): DynamicFormRecord {
  return Object.freeze({
    id: RECORD_ID, tenantId: 'tenant-001', formId: FORM_ID, formRevision: 2,
    values: Object.freeze({ budgetMinor: '90071992547409930', summary: { dataset: DATASET, recordId: '2026-08-09', version: '4' } }),
    version: 3, createdByActorId: 'employee-001',
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
}

describe('动态表单审批编译器', () => {
  it('把外部引用编译为来源、版本、观察时间、摘要和字段快照', () => {
    const source = form();
    const referenceField = source.items.find((item) => item.kind === 'field' && item.field.key === 'summary');
    if (referenceField?.kind !== 'field') throw new Error('test fixture');
    const compilation = compileDynamicFormApproval(source, [{ field: referenceField.field, schema: SCHEMA }]);
    expect(() => validateAndFreezeApprovalTemplateDefinition(compilation.definition)).not.toThrow();
    expect(compilation.definition.fields.map((field) => field.key)).toEqual(expect.arrayContaining([
      'gaoq_meta_record_id', 'gaoq_ext_1_record_id', 'gaoq_ext_1_version',
      'gaoq_ext_1_content_hash', 'gaoq_ext_1_summary_date', 'gaoq_ext_1_gmv_minor',
    ]));
    const snapshot: DatasetEvidenceSnapshot = {
      schema: DATASET, recordId: '2026-08-09', recordVersion: '4', observedAt: '2026-08-10T00:00:00.000Z',
      values: Object.freeze({ summaryDate: '2026-08-09', gmvMinor: '120001' }), contentHash: 'a'.repeat(43),
    };
    const data = compileDynamicFormApprovalData(source, record(), compilation, { summary: snapshot });
    expect(data).toMatchObject({
      budget_minor: '90071992547409930', gaoq_meta_record_version: 3,
      gaoq_ext_1_record_id: '2026-08-09', gaoq_ext_1_version: '4',
      gaoq_ext_1_gmv_minor: '120001', gaoq_ext_1_content_hash: 'a'.repeat(43),
    });
    expect(() => validateAndFreezeApprovalFormData(compilation.definition, data)).not.toThrow();
  });

  it('审批实例标识对记录版本稳定且不同版本不碰撞', () => {
    const first = dynamicFormApprovalInstanceId(FORM_ID, RECORD_ID, 3);
    expect(first).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(dynamicFormApprovalInstanceId(FORM_ID, RECORD_ID, 3)).toBe(first);
    expect(dynamicFormApprovalInstanceId(FORM_ID, RECORD_ID, 4)).not.toBe(first);
  });

  it('超长表单编码生成稳定且合法的审批模板编码', () => {
    const code = dynamicFormApprovalTemplateCode(`a${'b'.repeat(63)}`);
    expect(code.length).toBeLessThanOrEqual(64);
    expect(code).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });
});
