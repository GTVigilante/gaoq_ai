import { describe, expect, it, vi } from 'vitest';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js'; import type { SourcingRequest } from '../domain/sourcing.js'; import { SourcingService } from './sourcing.service.js';
const SUPPLIER = '01J8ZQK7V0A2M4N6P8R0T2W4Y9'; const session = { inTransaction: () => true };
const input = { title: '短视频剪辑季度寻源', serviceCategoryCode: 'video_editing', mode: 'directed_quote' as const, budgetCeilingMinor: '500000', currency: 'CNY' as const, ownerEmployeeId: 'employee-1', responsibleDepartmentId: 'department-1', responseDueAt: '2027-08-20T00:00:00.000Z', invitedSupplierIds: [SUPPLIER] };
function harness(scopes = ['erp:sourcing:management:write','erp:sourcing:management:read','erp:sourcing:management:decide','erp:sourcing:response:record','erp:supplier:eligibility:read','erp:supplier:self:opportunities:read','erp:supplier:self:response:write']) {
  const context = new TenantContextService(); const records = new Map<string, SourcingRequest>();
  const idempotency = { execute: vi.fn((_operation: string, _key: string, _input: unknown, handler: (value: typeof session) => Promise<unknown>) => handler(session)) };
  const employees = { findById: vi.fn(() => Promise.resolve({ id: 'employee-1', status: 'active', departmentIds: ['department-1'] })) };
  const repository = { insert: vi.fn((value: SourcingRequest) => { records.set(value.id, value); return Promise.resolve(); }), findById: vi.fn((id: string) => Promise.resolve(records.get(id) ?? null)), replace: vi.fn((value: SourcingRequest) => { records.set(value.id, value); return Promise.resolve(); }), search: vi.fn(() => Promise.resolve({ items: [...records.values()], nextCursor: null })), searchSupplierOpportunities: vi.fn(() => Promise.resolve({ items: [...records.values()].filter((value) => value.status === 'published'), nextCursor: null })) };
  const suppliers = {
    resolveEligibility: vi.fn(() => Promise.resolve({ supplierId: SUPPLIER, supplierVersion: 3, purpose: 'sourcing', serviceCategoryCode: 'video_editing', evaluatedAt: new Date().toISOString(), eligible: true, reasonCodes: [] as string[], digest: 'a'.repeat(43) })),
    resolveSelfSourcingControl: vi.fn((_permission: string, categories: readonly string[]) => Promise.resolve({
      supplierId: SUPPLIER, supplierVersion: 3,
      eligibility: categories.map((serviceCategoryCode) => ({ supplierId: SUPPLIER, supplierVersion: 3, purpose: 'sourcing_response', serviceCategoryCode, evaluatedAt: new Date().toISOString(), eligible: true, reasonCodes: [] as string[], digest: 'a'.repeat(43) })),
    })),
  };
  const outbox = { append: vi.fn(() => Promise.resolve(undefined)) }; const service = new SourcingService(context, idempotency as never, employees as never, repository as never, suppliers as never, outbox as never);
  const trusted = { tenant: { tenantId: 'tenant-a', source: 'access_token' as const }, actor: { actorType: 'user' as const, actorId: 'actor-1', tenantId: 'tenant-a', roleCodes: [], scopes, departmentIds: ['department-1'], traceId: 'trace-1' } };
  return { context, records, repository, suppliers, outbox, service, run: <T>(handler: () => T) => context.run(trusted, handler) };
}
describe('SourcingService', () => {
  it('完成创建、审批发布、资格复核响应、评估与选定', async () => { const h = harness(); await h.run(async () => { const created = await h.service.createDraft('sourcing-create-001', input); const id = created.request.id; await h.service.submit(id, 1, 'sourcing-submit-001'); await h.service.publish(id, 2, 'sourcing-publish-001', { approvalEvidenceRef: 'approval-1' }); await h.service.recordResponse(id, 3, 'sourcing-response-001', { supplierId: SUPPLIER, quotationMinor: '420000', proposalRef: 'proposal-1' }); await h.service.startEvaluation(id, 4, 'sourcing-evaluate-001'); const awarded = await h.service.award(id, 5, 'sourcing-award-001', { supplierId: SUPPLIER, agreedAmountMinor: '400000', decisionEvidenceRef: 'decision-1' }); expect(awarded.request).toMatchObject({ status: 'awarded', award: { supplierId: SUPPLIER } }); expect(h.suppliers.resolveEligibility).toHaveBeenCalledTimes(2); expect(h.outbox.append).toHaveBeenCalledTimes(6); }); });
  it('供应方资格失败时不写响应或选定', async () => { const h = harness(); h.suppliers.resolveEligibility.mockResolvedValue({ supplierId: SUPPLIER, supplierVersion: 4, purpose: 'sourcing_response', serviceCategoryCode: 'video_editing', evaluatedAt: '2026-08-11T01:00:00.000Z', eligible: false, reasonCodes: ['qualification_expired'], digest: 'b'.repeat(43) }); await h.run(async () => { const created = await h.service.createDraft('sourcing-create-001', input); const id = created.request.id; await h.service.submit(id, 1, 'sourcing-submit-001'); await h.service.publish(id, 2, 'sourcing-publish-001', { approvalEvidenceRef: 'approval-1' }); await expect(h.service.recordResponse(id, 3, 'sourcing-response-001', { supplierId: SUPPLIER, quotationMinor: '420000', proposalRef: 'proposal-1' })).rejects.toMatchObject({ response: { code: 'SOURCING_SUPPLIER_INELIGIBLE' } }); expect(h.repository.replace).toHaveBeenCalledTimes(2); }); });
  it('缺少 Scope 和跨部门均在持久化写入前失败', async () => { const denied = harness([]); await denied.run(async () => { await expect(denied.service.createDraft('sourcing-create-001', input)).rejects.toMatchObject({ response: { code: 'SOURCING_SCOPE_DENIED' } }); expect(denied.repository.insert).not.toHaveBeenCalled(); }); const scoped = harness(); await scoped.run(async () => { await expect(scoped.service.createDraft('sourcing-create-001', { ...input, responsibleDepartmentId: 'department-2' })).rejects.toMatchObject({ response: { code: 'SOURCING_OWNER_INVALID' } }); }); });
  it('本人商机按可信成员关系解析供应方，并且响应正文不接受 supplierId', async () => {
    const h = harness();
    await h.run(async () => {
      const created = await h.service.createDraft('sourcing-create-001', input);
      const id = created.request.id;
      await h.service.submit(id, 1, 'sourcing-submit-001');
      await h.service.publish(id, 2, 'sourcing-publish-001', { approvalEvidenceRef: 'approval-1' });
      const opportunities = await h.service.listSelfOpportunities({ limit: 20 });
      expect(opportunities.items).toEqual([
        expect.objectContaining({ id, responded: false, status: 'published' }),
      ]);
      expect(opportunities.items[0]).not.toHaveProperty('invitedSupplierIds');
      const responded = await h.service.recordSelfResponse(
        id, 3, 'sourcing-self-response-001',
        { quotationMinor: '420000', proposalRef: 'proposal-self-1' },
      );
      expect(responded.request).toMatchObject({ id, responded: true, ownQuotationMinor: '420000' });
      expect(h.suppliers.resolveSelfSourcingControl).toHaveBeenCalledWith('response_submit', []);
      expect(h.records.get(id)?.responses[0]?.supplierId).toBe(SUPPLIER);
    });
  });
  it('本人关系漂移时不登记响应', async () => {
    const h = harness();
    await h.run(async () => {
      const created = await h.service.createDraft('sourcing-create-001', input);
      const id = created.request.id;
      await h.service.submit(id, 1, 'sourcing-submit-001');
      await h.service.publish(id, 2, 'sourcing-publish-001', { approvalEvidenceRef: 'approval-1' });
      h.suppliers.resolveSelfSourcingControl
        .mockResolvedValueOnce({ supplierId: SUPPLIER, supplierVersion: 3, eligibility: [] })
        .mockResolvedValueOnce({ supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y8', supplierVersion: 3, eligibility: [] });
      await expect(h.service.recordSelfResponse(
        id, 3, 'sourcing-self-response-001',
        { quotationMinor: '420000', proposalRef: 'proposal-self-1' },
      )).rejects.toMatchObject({ response: { code: 'SOURCING_SELF_RELATIONSHIP_CHANGED' } });
      expect(h.repository.replace).toHaveBeenCalledTimes(2);
    });
  });
});
