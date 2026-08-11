import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SupplierMemberRelationship } from '../domain/supplier-member.js';
import { SupplierMemberService } from './supplier-member.service.js';

const SUPPLIER = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const SESSION = { inTransaction: () => true };
const INPUT = {
  actorId: 'supplier-user-1', performerRef: 'person-1', role: 'owner' as const,
  permissions: ['profile_read', 'catalog_manage', 'opportunities_read', 'response_submit', 'delivery_submit', 'income_read'] as const,
  evidenceRef: 'approval-1', validFrom: '2026-08-11',
};

function harness(partyKind: 'individual' | 'organization' = 'individual') {
  const context = new TenantContextService(); const records = new Map<string, SupplierMemberRelationship>();
  const idempotency = { execute: vi.fn((_operation: string, _key: string, _input: unknown, handler: (session: typeof SESSION) => Promise<unknown>) => handler(SESSION)) };
  const suppliers = { findById: vi.fn().mockResolvedValue({ id: SUPPLIER, partyKind, status: 'active', responsibleDepartmentId: 'department-1' }) };
  const members = {
    findAnyActiveBySupplier: vi.fn().mockResolvedValue(null),
    findActiveDuplicate: vi.fn().mockResolvedValue(null),
    insert: vi.fn((member: SupplierMemberRelationship) => { records.set(member.id, member); return Promise.resolve(); }),
    findById: vi.fn((id: string) => Promise.resolve(records.get(id) ?? null)),
    replace: vi.fn((member: SupplierMemberRelationship) => { records.set(member.id, member); return Promise.resolve(); }),
    listBySupplier: vi.fn(() => Promise.resolve([...records.values()])),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new SupplierMemberService(context, idempotency as never, suppliers as never, members as never, outbox as never);
  const trusted = { tenant: { tenantId: 'tenant-a', source: 'access_token' as const }, actor: {
    actorType: 'user' as const, actorId: 'admin-1', tenantId: 'tenant-a', roleCodes: [],
    scopes: ['erp:supplier:member:manage', 'erp:supplier:member:read'],
    departmentIds: ['department-1'], traceId: 'trace-1',
  } };
  return { members, outbox, records, service, run: <T>(handler: () => T) => context.run(trusted, handler) };
}

describe('SupplierMemberService', () => {
  it('在事务内授权、列出并撤销成员，事件不含证据正文', async () => {
    const value = harness();
    await value.run(async () => {
      const created = await value.service.create(SUPPLIER, 'supplier-member-create-001', { ...INPUT, permissions: [...INPUT.permissions] });
      expect(created.member).toMatchObject({ supplierId: SUPPLIER, role: 'owner', status: 'active' });
      expect(created.member).not.toHaveProperty('evidenceRef');
      expect((await value.service.list(SUPPLIER)).items).toHaveLength(1);
      const revoked = await value.service.revoke(
        SUPPLIER, created.member.id, 1, 'supplier-member-revoke-001',
        { reasonCode: 'authorization_withdrawn' },
      );
      expect(revoked.member).toMatchObject({ status: 'revoked', version: 2 });
      expect(value.outbox.append).toHaveBeenCalledTimes(2);
    });
  });

  it('个人供应方拒绝第二条有效本人关系', async () => {
    const value = harness(); value.members.findAnyActiveBySupplier.mockResolvedValue({});
    await value.run(async () => {
      await expect(value.service.create(
        SUPPLIER, 'supplier-member-create-001', { ...INPUT, permissions: [...INPUT.permissions] },
      )).rejects.toMatchObject({ response: { code: 'SUPPLIER_INDIVIDUAL_MEMBER_DUPLICATE' } });
      expect(value.members.insert).not.toHaveBeenCalled();
    });
  });

  it('组织供应方允许受限履约者，但领域拒绝其权限升级', async () => {
    const value = harness('organization');
    await value.run(async () => {
      await expect(value.service.create(SUPPLIER, 'supplier-member-create-001', {
        ...INPUT, role: 'performer', permissions: ['profile_read', 'delivery_submit', 'income_read'],
      })).rejects.toMatchObject({ response: { code: 'SUPPLIER_MEMBER_PERMISSION_ESCALATION' } });
      expect(value.members.insert).not.toHaveBeenCalled();
    });
  });
});
