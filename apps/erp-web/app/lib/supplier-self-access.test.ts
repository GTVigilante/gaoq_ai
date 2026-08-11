import { describe, expect, it } from 'vitest';

import { resolveSupplierSelfAccess } from './supplier-self-access';

describe('供应方本人门户权限', () => {
  it('履约者可读取档案与委托并交付，不暴露目录、响应或收入', () => {
    expect(resolveSupplierSelfAccess([
      'erp:supplier:self:read',
      'erp:supplier:self:engagements:read',
      'erp:supplier:self:delivery:write',
    ])).toEqual({
      profileRead: true, catalogManage: false,
      opportunitiesRead: false, responseWrite: false,
      engagementsRead: true, deliveryWrite: true, incomeRead: false,
    });
  });

  it('孤立写 Scope 不会绕过对应读取边界', () => {
    expect(resolveSupplierSelfAccess([
      'erp:supplier:self:read',
      'erp:supplier:self:response:write',
      'erp:supplier:self:delivery:write',
    ])).toMatchObject({ responseWrite: false, deliveryWrite: false });
  });

  it('未授予档案读取时整个本人门户失败关闭', () => {
    expect(Object.values(resolveSupplierSelfAccess([
      'erp:supplier:self:income:read',
      'erp:supplier:self:engagements:read',
    ])).every((value) => value === false)).toBe(true);
  });
});
