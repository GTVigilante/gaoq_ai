import { describe, expect, it } from 'vitest';

import { parseSupplierMemberList, parseSupplierMemberWrite } from './supplier-member-contract';

const MEMBER = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
  actorId: 'actor-1', performerRef: 'person-1', role: 'performer',
  permissions: ['profile_read', 'opportunities_read', 'delivery_submit'],
  validFrom: '2026-08-11', validUntil: null, status: 'active', revokedReasonCode: null,
  version: 1, createdAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z',
};

describe('供应方成员浏览器契约', () => {
  it('解析成员列表和写响应', () => {
    expect(parseSupplierMemberList({ items: [MEMBER] }).items[0]?.performerRef).toBe('person-1');
    expect(parseSupplierMemberWrite({ member: MEMBER }).member.status).toBe('active');
  });
  it('拒绝重复权限、未知字段和错误日期', () => {
    expect(() => parseSupplierMemberList({ items: [{ ...MEMBER, permissions: ['profile_read', 'profile_read'] }] })).toThrow();
    expect(() => parseSupplierMemberWrite({ member: { ...MEMBER, secret: true } })).toThrow();
    expect(() => parseSupplierMemberList({ items: [{ ...MEMBER, validFrom: '11/08/2026' }] })).toThrow();
  });
});
