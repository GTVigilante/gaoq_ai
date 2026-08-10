import { describe, expect, it, vi } from 'vitest';

import type { DynamicFormService } from '../application/dynamic-form.service.js';
import { NativeDynamicFormDatasetAdapter } from './native-dynamic-form-dataset.adapter.js';

const DATASET_ID = '01J00000000000000000000001';
const RECORD_ID = '01J00000000000000000000002';

describe('原生动态表单数据集 Adapter', () => {
  it('把已发布表单转换为版本化 Schema 并解析记录', async () => {
    const forms = {
      listPublishedCatalog: vi.fn().mockResolvedValue({ items: [{
        id: DATASET_ID, code: 'customer', name: '客户台账', revision: 2,
        fields: [
          { key: 'name', label: '名称', type: 'short_text', required: true, sensitivity: 'L1' },
          { key: 'secret_note', label: '私密备注', type: 'long_text', required: false, sensitivity: 'L4' },
        ],
      }] }),
      getRecord: vi.fn().mockResolvedValue({
        record: { id: RECORD_ID, formRevision: 2, version: 4, updatedAt: '2026-08-10T00:00:00.000Z' },
        resolvedValues: { name: '高潜客户', secret_note: '仅专用界面' },
      }),
    };
    const adapter = new NativeDynamicFormDatasetAdapter(forms as unknown as DynamicFormService);
    const catalog = await adapter.catalog();
    expect(catalog[0]).toMatchObject({
      ref: { kind: 'native', datasetId: DATASET_ID, schemaRevision: 2 },
      primaryFieldKey: 'name',
    });
    expect(catalog[0]?.fields[1]?.availability).toBe('dedicated_only');
    const record = await adapter.resolve({ dataset: catalog[0]!.ref, recordId: RECORD_ID });
    expect(record).toMatchObject({ recordId: RECORD_ID, version: '4', values: { name: '高潜客户' } });
  });

  it('拒绝记录修订与数据集修订漂移', async () => {
    const forms = {
      getRecord: vi.fn().mockResolvedValue({
        record: { id: RECORD_ID, formRevision: 3, version: 1, updatedAt: '2026-08-10T00:00:00.000Z' },
        resolvedValues: { name: '漂移' },
      }),
    };
    const adapter = new NativeDynamicFormDatasetAdapter(forms as unknown as DynamicFormService);
    await expect(adapter.resolve({
      dataset: { kind: 'native', datasetId: DATASET_ID, schemaRevision: 2 }, recordId: RECORD_ID,
    })).rejects.toThrow('记录不属于请求的数据集修订');
  });
});
