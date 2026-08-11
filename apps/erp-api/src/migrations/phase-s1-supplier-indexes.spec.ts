import { describe, expect, it } from 'vitest';

import { buildPhaseS1SupplierIndexManifest } from './phase-s1-supplier-indexes.js';

describe('Phase S1 供应方索引迁移', () => {
  it('覆盖供应关系与成员关系集合，并具有租户内唯一约束', () => {
    const manifest = buildPhaseS1SupplierIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'supplier_relationships', 'supplier_member_relationships',
    ]));
    expect(manifest.some((item) => item.key.tenantId === 1 && item.key.id === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) => item.key.tenantId === 1 && item.key.supplierNumber === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) => item.key.tenantId === 1 && item.key.identityFingerprint === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) => item.collection === 'supplier_member_relationships' && item.key.actorId === 1 && item.options.unique === true)).toBe(true);
    expect(manifest.some((item) => item.collection === 'supplier_member_relationships' && item.key.performerRef === 1 && item.options.unique === true)).toBe(true);
  });

  it('包含状态/责任部门与服务分类的固定查询索引', () => {
    const manifest = buildPhaseS1SupplierIndexManifest();
    expect(manifest.some((item) => item.key.status === 1 && item.key.responsibleDepartmentId === 1 && item.key.id === 1)).toBe(true);
    expect(manifest.some((item) => item.key['capabilities.serviceCategoryCode'] === 1 && item.key.status === 1)).toBe(true);
  });
});
