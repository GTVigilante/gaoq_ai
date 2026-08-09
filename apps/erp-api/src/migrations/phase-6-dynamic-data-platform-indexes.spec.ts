import { describe, expect, it } from 'vitest';

import { buildPhaseSixDynamicDataPlatformIndexManifest } from './phase-6-dynamic-data-platform-indexes.js';

describe('Phase 6 动态数据平台索引迁移', () => {
  it('只覆盖四个新增集合并包含租户内唯一键', () => {
    const manifest = buildPhaseSixDynamicDataPlatformIndexManifest();
    const collections = new Set(manifest.map((item) => item.collection));
    expect(collections).toEqual(new Set([
      'dynamic_form_definitions', 'dynamic_form_records', 'dynamic_form_relations',
      'multidimensional_bases',
    ]));
    for (const collection of collections) {
      expect(manifest.some((item) => item.collection === collection && item.key.tenantId === 1 && item.options.unique === true)).toBe(true);
    }
  });

  it('包含记录列表、双向关联和 Base 更新时间查询索引', () => {
    const manifest = buildPhaseSixDynamicDataPlatformIndexManifest();
    expect(manifest.some((item) => item.collection === 'dynamic_form_records' && item.key.formId === 1 && item.key.updatedAt === -1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'dynamic_form_relations' && item.key.sourceRecordId === 1 && item.key.fieldKey === 1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'dynamic_form_relations' && item.key.targetRecordId === 1 && item.key.sourceFormId === 1)).toBe(true);
    expect(manifest.some((item) => item.collection === 'multidimensional_bases' && item.key.updatedAt === -1)).toBe(true);
  });
});
