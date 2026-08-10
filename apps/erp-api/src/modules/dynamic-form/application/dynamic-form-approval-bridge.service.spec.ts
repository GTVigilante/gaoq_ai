import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  ApprovalApplicationService, DynamicFormApprovalSubmissionInput,
  GeneratedApprovalTemplateInput,
} from '../../approval/application/approval-application.service.js';
import { parseDatasetSchema, type DatasetEvidenceSnapshot } from '../domain/dataset-runtime.js';
import { parseFormDefinitionInput, type DynamicFormDefinition, type DynamicFormRecord } from '../domain/dynamic-form.js';
import type { ExternalDatasetReferenceService } from '../runtime/external-dataset-reference.service.js';
import { DynamicFormApprovalBridgeService } from './dynamic-form-approval-bridge.service.js';
import type { DynamicFormService } from './dynamic-form.service.js';

const FORM_ID = '01K00000000000000000000001';
const RECORD_ID = '01K00000000000000000000002';
const DATASET = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };
const SCHEMA = parseDatasetSchema({
  ref: DATASET, name: '经营摘要', primaryFieldKey: 'summaryDate',
  fields: [{ key: 'summaryDate', label: '经营日期', type: 'date', sensitivity: 'L1', required: true, readOnly: true, availability: 'generic' }],
  capabilities: { resolve: true, snapshot: true, query: 'exact', commands: [] },
});

function fixtures() {
  const parsed = parseFormDefinitionInput({
    code: 'op_review', name: '经营复核', items: [
      { kind: 'field', field: { id: '01K00000000000000000000003', key: 'reason', label: '原因', type: 'short_text', required: true, sensitivity: 'L1', width: 'full', description: '', placeholder: '' } },
      { kind: 'field', field: { id: '01K00000000000000000000004', key: 'summary', label: '摘要', type: 'dataset_reference', required: true, sensitivity: 'L2', width: 'full', description: '', placeholder: '', datasetReference: { dataset: DATASET, displayFieldKey: 'summaryDate', snapshotFieldKeys: [] } } },
    ], workflow: { riskLevel: 'R1', nodes: [{ id: 'review', name: '复核', type: 'approval', approvalMode: 'all', resolver: { type: 'initiator_manager' } }] },
  });
  const form: DynamicFormDefinition = Object.freeze({
    ...parsed, id: FORM_ID, tenantId: 'tenant-001', status: 'published', revision: 1, version: 2,
    createdByActorId: 'actor-001', publishedAt: '2026-08-10T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
  const record: DynamicFormRecord = Object.freeze({
    id: RECORD_ID, tenantId: 'tenant-001', formId: FORM_ID, formRevision: 1,
    values: Object.freeze({ reason: '复核经营数据', summary: { dataset: DATASET, recordId: '2026-08-09', version: '4' } }),
    version: 3, createdByActorId: 'actor-001', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
  const field = form.items.find((item) => item.kind === 'field' && item.field.key === 'summary');
  if (field?.kind !== 'field') throw new Error('test fixture');
  const snapshot: DatasetEvidenceSnapshot = {
    schema: DATASET, recordId: '2026-08-09', recordVersion: '4', observedAt: '2026-08-10T00:00:00.000Z',
    values: Object.freeze({ summaryDate: '2026-08-09' }), contentHash: 'a'.repeat(43),
  };
  return { form, record, field: field.field, snapshot };
}

function setup(scopes: readonly string[]) {
  const source = fixtures();
  const context = { getActorRequired: () => ({ scopes, actorType: 'user', actorId: 'actor-001' }) } as unknown as TenantContextService;
  const forms = {
    get: vi.fn().mockResolvedValue(source.form),
    getApprovalSource: vi.fn().mockResolvedValue({ form: source.form, record: source.record }),
  };
  const references = {
    schemas: vi.fn().mockResolvedValue([{ field: source.field, schema: SCHEMA }]),
    snapshotRecordReferences: vi.fn().mockResolvedValue({ summary: source.snapshot }),
  };
  const approvals = {
    syncGeneratedTemplate: vi.fn<(key: string, input: GeneratedApprovalTemplateInput) => Promise<{ template: { id: string; version: number } }>>().mockResolvedValue({ template: { id: 'template-001', version: 1 } }),
    createAndSubmitFromDynamicForm: vi.fn<(key: string, input: DynamicFormApprovalSubmissionInput) => Promise<{ instance: { id: string; version: number } }>>().mockResolvedValue({ instance: { id: RECORD_ID, version: 2 } }),
  };
  return {
    source, forms, references, approvals,
    service: new DynamicFormApprovalBridgeService(
      context, forms as unknown as DynamicFormService,
      references as unknown as ExternalDatasetReferenceService,
      approvals as unknown as ApprovalApplicationService,
    ),
  };
}

describe('动态表单审批桥', () => {
  it('模板只由后端编译并绑定表单来源修订', async () => {
    const store = setup(['erp:approval:template:write']);
    await store.service.syncTemplate(FORM_ID, 2, 'approval-template-sync-001');
    expect(store.approvals.syncGeneratedTemplate).toHaveBeenCalledWith(
      'approval-template-sync-001',
      expect.objectContaining({ source: { type: 'dynamic_form', id: FORM_ID, revision: 1 }, code: 'op_review.approval' }),
    );
  });

  it('提交时固定外部证据并绑定精确表单记录版本', async () => {
    const store = setup(['erp:approval:instance:submit']);
    await store.service.submitRecord(FORM_ID, RECORD_ID, 3, 'approval-submit-001');
    expect(store.references.snapshotRecordReferences).toHaveBeenCalledWith(store.source.form, store.source.record.values);
    const submitted = store.approvals.createAndSubmitFromDynamicForm.mock.calls[0];
    expect(submitted?.[0]).toBe('approval-submit-001');
    expect(submitted?.[1]).toMatchObject({
      sourceFormId: FORM_ID, sourceRecordId: RECORD_ID, sourceRecordVersion: 3,
      initiatorActorId: 'actor-001',
    });
    expect(submitted?.[1].formData).toMatchObject({
      gaoq_ext_1_record_id: '2026-08-09', gaoq_ext_1_content_hash: 'a'.repeat(43),
    });
  });
});
