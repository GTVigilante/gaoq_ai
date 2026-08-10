import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { parseDatasetSchema } from '../domain/dataset-runtime.js';
import type { NativeDynamicFormDatasetAdapter } from './native-dynamic-form-dataset.adapter.js';
import type { OpOperatingSummaryDatasetAdapter } from './op-operating-summary-dataset.adapter.js';
import { DatasetRuntimeService } from './dataset-runtime.service.js';

const NATIVE_REF = { kind: 'native' as const, datasetId: '01J00000000000000000000001', schemaRevision: 1 };
const OP_REF = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };
const nativeSchema = parseDatasetSchema({
  ref: NATIVE_REF, name: '项目', primaryFieldKey: 'name',
  fields: [{ key: 'name', label: '名称', type: 'short_text', sensitivity: 'L1', required: true, readOnly: false, availability: 'generic' }],
  capabilities: { resolve: true, snapshot: true, query: 'none', commands: [] },
});
const opSchema = parseDatasetSchema({
  ref: OP_REF, name: '经营摘要', primaryFieldKey: 'summaryDate',
  fields: [{ key: 'summaryDate', label: '日期', type: 'date', sensitivity: 'L1', required: true, readOnly: true, availability: 'generic' }],
  capabilities: { resolve: true, snapshot: true, query: 'exact', commands: [] },
});

function runtime(scopes: readonly string[]) {
  const context = { getActorRequired: () => ({ scopes }) } as unknown as TenantContextService;
  const native = {
    code: 'native', requiredScope: 'erp:forms:data:read', accepts: (ref: typeof NATIVE_REF | typeof OP_REF) => ref.kind === 'native',
    catalog: vi.fn().mockResolvedValue([nativeSchema]), describe: vi.fn().mockResolvedValue(nativeSchema),
    resolve: vi.fn().mockResolvedValue({ dataset: NATIVE_REF, recordId: '01J00000000000000000000002', version: '2', values: { name: '项目 A' }, observedAt: '2026-08-10T00:00:00.000Z' }), query: vi.fn(),
  };
  const op = {
    code: 'op', requiredScope: 'erp:op:operating_summary:read', accepts: (ref: typeof NATIVE_REF | typeof OP_REF) => ref.kind === 'external' && ref.system === 'op',
    catalog: vi.fn().mockResolvedValue([opSchema]), describe: vi.fn().mockResolvedValue(opSchema), resolve: vi.fn(),
    query: vi.fn().mockResolvedValue([{ dataset: OP_REF, recordId: '2026-08-09', version: '4', values: { summaryDate: '2026-08-09' }, observedAt: '2026-08-10T00:00:00.000Z' }]),
  };
  return {
    service: new DatasetRuntimeService(context, native as unknown as NativeDynamicFormDatasetAdapter, op as unknown as OpOperatingSummaryDatasetAdapter),
    native, op,
  };
}

describe('统一数据集运行时', () => {
  it('目录只返回当前主体拥有来源 Scope 的数据集', async () => {
    const store = runtime(['erp:forms:data:read']);
    await expect(store.service.catalog()).resolves.toEqual({ items: [nativeSchema] });
    expect(store.op.catalog).not.toHaveBeenCalled();
  });

  it('目录条目必须由返回它的 Adapter 真实接管', async () => {
    const store = runtime(['erp:forms:data:read']);
    store.native.catalog.mockResolvedValue([opSchema]);
    await expect(store.service.catalog()).rejects.toThrow('DATASET_CATALOG_ADAPTER_MISMATCH');
  });

  it('通过 Adapter seam 解析、投影并生成确定性证据摘要', async () => {
    const store = runtime(['erp:forms:data:read']);
    const input = { record: { dataset: NATIVE_REF, recordId: '01J00000000000000000000002', version: '2' }, fieldKeys: ['name'] };
    await expect(store.service.resolve(input)).resolves.toMatchObject({ values: { name: '项目 A' }, ref: { version: '2' } });
    const first = await store.service.snapshot(input);
    const second = await store.service.snapshot(input);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('缺少来源 Scope 时在调用 Adapter 前失败关闭', async () => {
    const store = runtime(['erp:bases:workspace:read']);
    await expect(store.service.resolve({ record: { dataset: NATIVE_REF, recordId: '01J00000000000000000000002' } })).rejects.toThrow('当前身份无权读取该数据集来源');
    expect(store.native.describe).not.toHaveBeenCalled();
    expect(store.native.resolve).not.toHaveBeenCalled();
  });

  it('只允许 Adapter 声明的精确查询并校验返回记录唯一性', async () => {
    const store = runtime(['erp:op:operating_summary:read']);
    await expect(store.service.query({
      dataset: OP_REF, filters: [{ fieldKey: 'summaryDate', operator: 'eq', value: '2026-08-09' }], limit: 10,
    })).resolves.toMatchObject({ items: [{ values: { summaryDate: '2026-08-09' } }] });
    expect(store.op.query).toHaveBeenCalledOnce();
  });
});
