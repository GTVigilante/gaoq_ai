import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SupplierMemberRelationship } from '../domain/supplier-member.js';
import { SupplierMemberAuthorizationService } from './supplier-member-authorization.service.js';

const SUPPLIER = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const MEMBER = Object.freeze({
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', tenantId: 'tenant-a', supplierId: SUPPLIER,
  actorId: 'actor-1', performerRef: 'person-1', role: 'owner' as const,
  permissions: Object.freeze(['profile_read', 'delivery_submit'] as const),
  evidenceRef: 'approval-1', validFrom: '2026-08-01', validUntil: null,
  status: 'active' as const, revokedReasonCode: null, version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
});

function harness(actorType: 'user' | 'service' = 'user') {
  const context = new TenantContextService();
  const members = {
    listActiveByActor: vi.fn().mockResolvedValue([MEMBER]),
    listActivePerformers: vi.fn().mockResolvedValue([MEMBER]),
  };
  const service = new SupplierMemberAuthorizationService(context, members as never);
  const trusted = { tenant: { tenantId: 'tenant-a', source: 'access_token' as const }, actor: {
    actorType, actorId: 'actor-1', tenantId: 'tenant-a', roleCodes: [], scopes: [],
    departmentIds: [], traceId: 'trace-1',
  } };
  return { members, service, run: <T>(handler: () => T) => context.run(trusted, handler) };
}

describe('SupplierMemberAuthorizationService', () => {
  it('只为用户委托身份解析唯一有效本人关系', async () => {
    const value = harness();
    await value.run(async () => {
      await expect(value.service.resolveUniqueSelf('profile_read')).resolves.toBe(MEMBER);
      expect(value.members.listActiveByActor).toHaveBeenCalledWith(
        'actor-1', 'profile_read', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      );
    });
    const service = harness('service');
    await service.run(async () => {
      await expect(service.service.resolveUniqueSelf('profile_read')).rejects.toMatchObject({
        response: { code: 'SUPPLIER_SELF_USER_REQUIRED' },
      });
      expect(service.members.listActiveByActor).not.toHaveBeenCalled();
    });
  });

  it('关系歧义及缺失履约者均失败关闭', async () => {
    const value = harness();
    value.members.listActiveByActor.mockResolvedValue([MEMBER, { ...MEMBER, id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6' }]);
    await value.run(async () => {
      await expect(value.service.resolveUniqueSelf('profile_read')).rejects.toMatchObject({
        response: { code: 'SUPPLIER_SELF_RELATIONSHIP_UNRESOLVED' },
      });
      value.members.listActivePerformers.mockResolvedValue([] as SupplierMemberRelationship[]);
      await expect(value.service.assertPerformersAuthorized(
        SUPPLIER, 'individual', ['person-1'], new Date('2026-08-11T00:00:00.000Z'),
      )).rejects.toMatchObject({ response: { code: 'SUPPLIER_PERFORMER_UNAUTHORIZED' } });
    });
  });
});
