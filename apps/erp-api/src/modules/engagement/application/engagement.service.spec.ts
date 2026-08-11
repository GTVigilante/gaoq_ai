import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ServiceEngagement } from '../domain/engagement.js';
import { EngagementService } from './engagement.service.js';

const REQUEST_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const SUPPLIER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const SESSION = { inTransaction: () => true };
const SOURCING_AWARD = Object.freeze({
  id: REQUEST_ID,
  status: 'awarded' as const,
  award: Object.freeze({ supplierId: SUPPLIER_ID, agreedAmountMinor: '400000' }),
  serviceCategoryCode: 'video_editing',
  responsibleDepartmentId: 'department-1',
  ownerEmployeeId: 'employee-1',
  version: 6,
});

function harness(scopes = [
  'erp:engagement:management:write',
  'erp:engagement:management:read',
  'erp:engagement:management:read_all',
  'erp:engagement:management:decide',
  'erp:engagement:delivery:record',
  'erp:engagement:management:accept',
  'erp:payables:materialize',
  'erp:supplier:self:engagements:read',
  'erp:supplier:self:delivery:write',
]) {
  const context = new TenantContextService();
  const records = new Map<string, ServiceEngagement>();
  const idempotency = {
    execute: vi.fn(
      (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: typeof SESSION) => Promise<unknown>,
      ) => handler(SESSION),
    ),
  };
  const sourcing = { get: vi.fn().mockResolvedValue(SOURCING_AWARD) };
  const suppliers = {
    getEngagementPartyKind: vi.fn().mockResolvedValue({ supplierId: SUPPLIER_ID, partyKind: 'organization' }),
    resolveEligibility: vi.fn().mockResolvedValue({
      supplierId: SUPPLIER_ID,
      supplierVersion: 4,
      purpose: 'engagement_activate',
      serviceCategoryCode: 'video_editing',
      evaluatedAt: '2026-08-11T01:00:00.000Z',
      eligible: true,
      reasonCodes: [],
      digest: 'a'.repeat(43),
    }),
  };
  const memberAuthorization = {
    assertPerformersAuthorized: vi.fn().mockResolvedValue(undefined),
    resolveUniqueSelf: vi.fn().mockResolvedValue({
      supplierId: SUPPLIER_ID, performerRef: 'performer-1',
    }),
  };
  const repository = {
    insert: vi.fn((value: ServiceEngagement) => {
      records.set(value.id, value);
      return Promise.resolve();
    }),
    findById: vi.fn((id: string) => Promise.resolve(records.get(id) ?? null)),
    replace: vi.fn((value: ServiceEngagement) => {
      records.set(value.id, value);
      return Promise.resolve();
    }),
    search: vi.fn(() =>
      Promise.resolve({ items: Object.freeze([...records.values()]), nextCursor: null }),
    ),
    searchForSupplierMember: vi.fn(() =>
      Promise.resolve({ items: Object.freeze([...records.values()]), nextCursor: null }),
    ),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue(undefined),
    appendSignatureRequest: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EngagementService(
    context,
    idempotency as never,
    sourcing as never,
    suppliers as never,
    memberAuthorization as never,
    repository as never,
    outbox as never,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: {
      actorType: 'user' as const,
      actorId: 'actor-1',
      tenantId: 'tenant-a',
      roleCodes: [],
      scopes,
      departmentIds: ['department-1'],
      traceId: 'trace-1',
    },
  };
  return {
    outbox,
    records,
    repository,
    run: <T>(handler: () => T) => context.run(trusted, handler),
    service,
    sourcing,
    suppliers,
    memberAuthorization,
  };
}

describe('EngagementService', () => {
  it('从可信选定创建委托，激活时复核资格，并仅从验收终态导出应付来源', async () => {
    const value = harness();
    await value.run(async () => {
      const created = await value.service.create('engagement-create-001', {
        sourcingRequestId: REQUEST_ID,
        performerRefs: ['performer-1'],
      });
      const id = created.engagement.id;
      await value.service.submit(id, 1, 'engagement-submit-001');
      await value.service.approve(id, 2, 'engagement-approve-001', { evidenceRef: 'approval-1' });
      await value.service.activate(id, 3, 'engagement-activate-001', { evidenceRef: 'signature-1' });
      await value.service.deliver(id, 4, 'engagement-deliver-001', {
        artifactRef: 'artifact-1',
        supplierId: SUPPLIER_ID,
      });
      await value.service.accept(id, 5, 'engagement-accept-001', { evidenceRef: 'acceptance-1' });
      await expect(value.service.getAcceptedPayableSource(id)).resolves.toMatchObject({
        engagementId: id,
        engagementVersion: 6,
        supplierId: SUPPLIER_ID,
        grossAmountMinor: '400000',
        acceptanceEvidenceRef: 'acceptance-1',
      });
      expect(value.suppliers.resolveEligibility).toHaveBeenCalledOnce();
      expect(value.outbox.append).toHaveBeenCalledTimes(6);
    });
  });

  it('供应方资格失效时不激活委托或发布事件', async () => {
    const value = harness();
    value.suppliers.resolveEligibility.mockResolvedValue({
      supplierId: SUPPLIER_ID,
      supplierVersion: 5,
      purpose: 'engagement_activate',
      serviceCategoryCode: 'video_editing',
      evaluatedAt: '2026-08-11T01:00:00.000Z',
      eligible: false,
      reasonCodes: ['supplier_suspended'],
      digest: 'b'.repeat(43),
    });
    await value.run(async () => {
      const created = await value.service.create('engagement-create-001', {
        sourcingRequestId: REQUEST_ID,
        performerRefs: [],
      });
      const id = created.engagement.id;
      await value.service.submit(id, 1, 'engagement-submit-001');
      await value.service.approve(id, 2, 'engagement-approve-001', { evidenceRef: 'approval-1' });
      await expect(
        value.service.activate(id, 3, 'engagement-activate-001', { evidenceRef: 'signature-1' }),
      ).rejects.toMatchObject({ response: { code: 'ENGAGEMENT_SUPPLIER_INELIGIBLE' } });
      expect(value.repository.replace).toHaveBeenCalledTimes(2);
      expect(value.outbox.append).toHaveBeenCalledTimes(3);
    });
  });

  it('缺少应用服务 Scope 时不读取寻源事实', async () => {
    const value = harness([]);
    await value.run(async () => {
      await expect(
        value.service.create('engagement-create-001', {
          sourcingRequestId: REQUEST_ID,
          performerRefs: [],
        }),
      ).rejects.toMatchObject({ response: { code: 'ENGAGEMENT_SCOPE_DENIED' } });
      expect(value.sourcing.get).not.toHaveBeenCalled();
    });
  });

  it('本人只能列出包含其履约者引用的委托，并以可信供应关系提交交付', async () => {
    const value = harness();
    await value.run(async () => {
      const created = await value.service.create('engagement-create-001', {
        sourcingRequestId: REQUEST_ID, performerRefs: ['performer-1'],
      });
      const id = created.engagement.id;
      await value.service.submit(id, 1, 'engagement-submit-001');
      await value.service.approve(id, 2, 'engagement-approve-001', { evidenceRef: 'approval-1' });
      await value.service.activate(id, 3, 'engagement-activate-001', { evidenceRef: 'signature-1' });
      const list = await value.service.listSelf({ limit: 20 });
      expect(list.items).toEqual([expect.objectContaining({ id, deliveryCount: 0 })]);
      expect(list.items[0]).not.toHaveProperty('supplierId');
      const delivered = await value.service.deliverSelf(
        id, 4, 'engagement-self-deliver-001', { artifactRef: 'artifact-self-1' },
      );
      expect(delivered.engagement).toMatchObject({ status: 'delivered', deliveryCount: 1 });
      expect(value.memberAuthorization.resolveUniqueSelf).toHaveBeenCalledWith('delivery_submit');
      expect(value.records.get(id)?.deliveries[0]?.submittedBySupplierId).toBe(SUPPLIER_ID);
    });
  });
});
