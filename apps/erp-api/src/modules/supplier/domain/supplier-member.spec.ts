import { describe, expect, it } from 'vitest';

import {
  createSupplierMember, isSupplierMemberActiveAt, restoreSupplierMember,
  revokeSupplierMember,
} from './supplier-member.js';

const NOW = new Date('2026-08-11T00:00:00.000Z');
const INPUT = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', tenantId: 'tenant-a',
  supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9', actorId: 'actor-1',
  performerRef: 'person-1', role: 'owner' as const,
  permissions: [
    'profile_read', 'catalog_manage', 'opportunities_read',
    'response_submit', 'delivery_submit', 'income_read',
  ] as const,
  evidenceRef: 'approval-1', validFrom: '2026-08-11', validUntil: null,
};

describe('SupplierMember 领域', () => {
  it('显式冻结成员权限并按有效期解析', () => {
    const member = createSupplierMember(INPUT, NOW);
    expect(member).toMatchObject({ status: 'active', version: 1 });
    expect(isSupplierMemberActiveAt(member, '2026-08-11T12:00:00.000Z')).toBe(true);
    expect(Object.isFrozen(member.permissions)).toBe(true);
    expect(restoreSupplierMember(structuredClone(member))).toEqual(member);
  });

  it('履约者角色不能获得目录、响应或收入权限', () => {
    expect(() => createSupplierMember({
      ...INPUT, role: 'performer', permissions: ['profile_read', 'delivery_submit', 'income_read'],
    }, NOW)).toThrow('SUPPLIER_MEMBER_PERMISSION_ESCALATION');
  });

  it('所有成员必须能读取本人档案，所有者必须拥有完整权限', () => {
    expect(() => createSupplierMember({
      ...INPUT, permissions: ['profile_read', 'delivery_submit'],
    }, NOW)).toThrow('SUPPLIER_MEMBER_OWNER_PERMISSIONS_INCOMPLETE');
    expect(() => createSupplierMember({
      ...INPUT, role: 'manager', permissions: ['opportunities_read'],
    }, NOW)).toThrow('SUPPLIER_MEMBER_PROFILE_PERMISSION_MISSING');
    expect(() => createSupplierMember({
      ...INPUT, role: 'performer', permissions: ['delivery_submit'],
    }, NOW)).toThrow('SUPPLIER_MEMBER_PROFILE_PERMISSION_MISSING');
  });

  it('履约者至少具备档案读取与交付权限', () => {
    expect(() => createSupplierMember({
      ...INPUT, role: 'performer', permissions: ['profile_read'],
    }, NOW)).toThrow('SUPPLIER_MEMBER_PERFORMER_PERMISSION_MISSING');
    expect(createSupplierMember({
      ...INPUT, role: 'performer', permissions: ['profile_read', 'delivery_submit'],
    }, NOW).permissions).toEqual(['delivery_submit', 'profile_read']);
  });

  it('撤销为终态且保留原因与强版本', () => {
    const revoked = revokeSupplierMember(createSupplierMember(INPUT, NOW), 'authorization_withdrawn', NOW);
    expect(revoked).toMatchObject({ status: 'revoked', version: 2, revokedReasonCode: 'authorization_withdrawn' });
    expect(isSupplierMemberActiveAt(revoked, '2026-08-11T12:00:00.000Z')).toBe(false);
    expect(() => revokeSupplierMember(revoked, 'again', NOW)).toThrow('SUPPLIER_MEMBER_REVOKE_STATE_INVALID');
  });
});
