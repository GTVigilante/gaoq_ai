import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseDatasetSchema } from '../domain/dataset-runtime.js';
import { parseFormDefinitionInput, type DynamicFormDefinition } from '../domain/dynamic-form.js';
import type { OpOperatingSummaryDatasetAdapter } from './op-operating-summary-dataset.adapter.js';
import { ExternalDatasetReferenceService } from './external-dataset-reference.service.js';

const FORM_ID = '01K00000000000000000000001';
const DATASET = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };
const SCHEMA = parseDatasetSchema({
  ref: DATASET, name: 'OP 每日经营摘要', primaryFieldKey: 'summaryDate',
  fields: [
    { key: 'summaryDate', label: '经营日期', type: 'date', sensitivity: 'L1', required: true, readOnly: true, availability: 'generic' },
    { key: 'gmvMinor', label: 'GMV（分）', type: 'money_minor', sensitivity: 'L2', required: true, readOnly: true, availability: 'generic' },
    { key: 'bankDetail', label: '银行明细', type: 'short_text', sensitivity: 'L4', required: false, readOnly: true, availability: 'dedicated_only' },
  ], capabilities: { resolve: true, snapshot: true, query: 'exact', commands: [] },
});

function form(snapshotFieldKeys: readonly string[] = ['gmvMinor']): DynamicFormDefinition {
  const definition = parseFormDefinitionInput({
    code: 'op_review', name: '经营复核', items: [{ kind: 'field', field: {
      id: FORM_ID, key: 'summary', label: '经营摘要', type: 'dataset_reference', required: true,
      sensitivity: 'L2', width: 'full', description: '', placeholder: '',
      datasetReference: { dataset: DATASET, displayFieldKey: 'summaryDate', snapshotFieldKeys },
    } }],
  });
  return Object.freeze({
    ...definition, id: FORM_ID, tenantId: 'tenant-001', status: 'published', revision: 1, version: 1,
    createdByActorId: 'employee-001', publishedAt: '2026-08-10T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
}

function setup(scopes: readonly string[] = ['erp:op:operating_summary:read']) {
  const context = { getActorRequired: () => ({ scopes }) } as unknown as TenantContextService;
  const adapter = {
    requiredScope: 'erp:op:operating_summary:read',
    accepts: vi.fn().mockReturnValue(true),
    describe: vi.fn().mockResolvedValue(SCHEMA),
    resolve: vi.fn().mockResolvedValue({
      dataset: DATASET, recordId: '2026-08-09', version: '4', observedAt: '2026-08-10T00:00:00.000Z',
      values: { summaryDate: '2026-08-09', gmvMinor: '120001' },
    }),
  };
  return { service: new ExternalDatasetReferenceService(context, adapter as unknown as OpOperatingSummaryDatasetAdapter), adapter };
}

describe('外部数据引用运行时', () => {
  it('在发布前验证显示字段和证据快照字段均为通用字段', async () => {
    const { service } = setup();
    await expect(service.validateDefinition(form())).resolves.toBeUndefined();
    await expect(service.validateDefinition(form(['bankDetail']))).rejects.toThrow('FORM_DATASET_REFERENCE_FIELD_INVALID');
  });

  it('写记录前反向绑定权威记录版本并投影允许字段', async () => {
    const { service, adapter } = setup();
    await expect(service.assertRecordReferences(form(), {
      summary: { dataset: DATASET, recordId: '2026-08-09', version: '4' },
    })).resolves.toBeUndefined();
    expect(adapter.resolve).toHaveBeenCalledOnce();
    await expect(service.assertRecordReferences(form(), {
      summary: { dataset: DATASET, recordId: '2026-08-09', version: '3' },
    })).rejects.toThrow('数据集记录版本已变化');
  });

  it('审批快照覆盖权威版本、观察时间和允许字段', async () => {
    const { service } = setup();
    const snapshots = await service.snapshotRecordReferences(form(), {
      summary: { dataset: DATASET, recordId: '2026-08-09', version: '4' },
    });
    expect(snapshots.summary).toMatchObject({
      schema: DATASET, recordId: '2026-08-09', recordVersion: '4',
      observedAt: '2026-08-10T00:00:00.000Z',
      values: { summaryDate: '2026-08-09', gmvMinor: '120001' },
    });
    expect(snapshots.summary?.contentHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('缺少来源权限时在调用 Adapter 前失败关闭', async () => {
    const { service, adapter } = setup([]);
    await expect(service.validateDefinition(form())).rejects.toThrow('当前身份无权引用该外部数据集');
    expect(adapter.describe).not.toHaveBeenCalled();
  });

  it('Adapter 返回其他来源或版本的 Schema 时失败关闭', async () => {
    const { service, adapter } = setup();
    adapter.describe.mockResolvedValueOnce(parseDatasetSchema({
      ...SCHEMA,
      ref: { ...DATASET, schemaVersion: '2.0' },
    }));
    await expect(service.validateDefinition(form())).rejects.toThrow('FORM_DATASET_SCHEMA_REF_MISMATCH');
  });
});
