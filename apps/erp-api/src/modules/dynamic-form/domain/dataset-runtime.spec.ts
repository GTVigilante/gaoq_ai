import { describe, expect, it } from 'vitest';

import {
  datasetRefKey,
  parseDatasetRef,
  parseDatasetSchema,
  parseResolveDatasetRecord,
  parseResolvedDatasetRecord,
  projectDatasetRecord,
  runtimeField,
} from './dataset-runtime.js';

const DATASET_ID = '01J00000000000000000000001';
const RECORD_ID = '01J00000000000000000000002';
const REF = { kind: 'native' as const, datasetId: DATASET_ID, schemaRevision: 3 };
const SCHEMA = parseDatasetSchema({
  ref: REF, name: '客户台账', primaryFieldKey: 'name',
  fields: [
    runtimeField({ key: 'name', label: '名称', type: 'short_text', sensitivity: 'L1', required: true, readOnly: false }),
    runtimeField({ key: 'private_note', label: '私密备注', type: 'long_text', sensitivity: 'L3', required: false, readOnly: false }),
  ],
  capabilities: { resolve: true, snapshot: true, query: 'none', commands: [] },
});

describe('数据集运行时领域契约', () => {
  it('将原生 Schema 修订纳入稳定数据集身份', () => {
    expect(datasetRefKey(parseDatasetRef(REF))).toBe(`native:${DATASET_ID}:3`);
    expect(Object.isFrozen(SCHEMA.fields)).toBe(true);
  });

  it('反向绑定 Adapter 返回的来源、记录和版本', () => {
    const request = parseResolveDatasetRecord({ record: { dataset: REF, recordId: RECORD_ID, version: '7' }, fieldKeys: ['name'] });
    const record = parseResolvedDatasetRecord({
      dataset: REF, recordId: RECORD_ID, version: '7',
      values: { name: '华东客户', private_note: '受限' },
      observedAt: '2026-08-10T00:00:00.000Z',
    }, request.record, SCHEMA);
    expect(projectDatasetRecord(record, SCHEMA, request.fieldKeys).values).toEqual({ name: '华东客户' });
    expect(() => parseResolvedDatasetRecord({
      dataset: REF, recordId: RECORD_ID, version: '8', values: { name: '变化' },
      observedAt: '2026-08-10T00:00:00.000Z',
    }, request.record, SCHEMA)).toThrowError('数据集记录版本已变化');
  });

  it('通用运行时拒绝读取 L3/L4 专用字段', () => {
    const record = parseResolvedDatasetRecord({
      dataset: REF, recordId: RECORD_ID, version: '7',
      values: { name: '华东客户', private_note: '受限' },
      observedAt: '2026-08-10T00:00:00.000Z',
    }, { dataset: REF, recordId: RECORD_ID }, SCHEMA);
    expect(() => projectDatasetRecord(record, SCHEMA, ['private_note'])).toThrowError('敏感字段只能由专用业务界面读取');
  });

  it('拒绝未知字段、重复投影和非规范引用', () => {
    expect(() => parseResolveDatasetRecord({ record: { dataset: REF, recordId: RECORD_ID }, fieldKeys: ['name', 'name'] })).toThrow();
    expect(() => parseResolvedDatasetRecord({
      dataset: REF, recordId: RECORD_ID, version: '1', values: { injected: true },
      observedAt: '2026-08-10T00:00:00.000Z',
    }, { dataset: REF, recordId: RECORD_ID }, SCHEMA)).toThrowError('数据集记录包含未知字段');
    expect(() => parseDatasetRef({ kind: 'external', system: 'op', objectType: 'customer', schemaVersion: '1.0', url: 'https://evil.example' })).toThrow();
  });
});
