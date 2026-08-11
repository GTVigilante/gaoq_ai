import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SupplierRelationship } from '../domain/supplier.js';
import { SupplierService } from './supplier.service.js';
import type { CreateSupplierDraftDto } from './supplier.dto.js';

const INPUT: CreateSupplierDraftDto = {
  partyKind: 'individual', legalForm: 'individual', displayName: '林一工作室',
  legalIdentity: { identifierType: 'national_id', identifier: '110101199001011234', legalName: '林一' },
  ownerEmployeeId: 'employee-1', responsibleDepartmentId: 'department-1', riskTier: 'medium',
  capabilities: [{ serviceCategoryCode: 'video_editing', level: 'verified', evidenceRef: 'capability-evidence', validUntil: '2027-12-31' }],
  rates: [{ serviceCategoryCode: 'video_editing', unit: 'per_project', amountMinor: '120000', currency: 'CNY', taxIncluded: true, validFrom: '2026-08-01' }],
};
const session = { inTransaction: () => true };

function harness(scopes = [
  'erp:supplier:relationship:write', 'erp:supplier:relationship:read', 'erp:supplier:relationship:decide',
  'erp:supplier:eligibility:read', 'erp:supplier:catalog:write',
]) {
  const context = new TenantContextService(); const values = new Map<string, SupplierRelationship>();
  const idempotency = { execute: vi.fn((_operation: string, _key: string, _request: unknown, handler: (value: typeof session) => Promise<unknown>) => handler(session)) };
  const employees = { findById: vi.fn(() => Promise.resolve({ id: 'employee-1', status: 'active', departmentIds: ['department-1'], primaryDepartmentId: 'department-1' })) };
  const repository = {
    insert: vi.fn((value: SupplierRelationship) => { values.set(value.id, value); return Promise.resolve(); }),
    findById: vi.fn((id: string) => Promise.resolve(values.get(id) ?? null)),
    findByFingerprints: vi.fn((fingerprints: readonly string[]) => Promise.resolve([...values.values()].filter((item) => fingerprints.includes(item.identityFingerprint)).map((item) => ({ id: item.id, fingerprint: item.identityFingerprint })))),
    replace: vi.fn((value: SupplierRelationship) => { values.set(value.id, value); return Promise.resolve(); }),
    search: vi.fn(() => Promise.resolve({ items: Object.freeze([...values.values()]), nextCursor: null })),
  };
  const crypto = {
    identityFingerprints: vi.fn(() => [`blind-v1.${'a'.repeat(43)}`]), identityHint: vi.fn(() => '****1234'),
    protect: vi.fn(() => ({ keyId: 'enc-v1', iv: 'a'.repeat(16), ciphertext: 'ciphertext', authTag: 'b'.repeat(22) })),
  };
  const outbox = { append: vi.fn(() => Promise.resolve(undefined)), appendCatalog: vi.fn(() => Promise.resolve(undefined)), appendQualification: vi.fn(() => Promise.resolve(undefined)) };
  const memberAuthorization = { resolveUniqueSelf: vi.fn() };
  const service = new SupplierService(context, idempotency as never, employees as never, repository as never, crypto as never, outbox as never, memberAuthorization as never);
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: { actorType: 'user' as const, actorId: 'actor-1', tenantId: 'tenant-a', roleCodes: [], scopes, departmentIds: ['department-1'], traceId: 'trace-1' },
  };
  return { context, values, repository, crypto, outbox, run: <T>(handler: () => T) => context.run(trusted, handler), service };
}

describe('SupplierService', () => {
  it('完成个人供应方创建、提交、批准与资格解析，且响应不含身份指纹和原文', async () => {
    const h = harness();
    await h.run(async () => {
      const created = await h.service.createDraft('supplier-create-001', INPUT);
      expect(created.supplier).toMatchObject({ status: 'draft', identityHint: '****1234', version: 1 });
      expect(created.supplier).not.toHaveProperty('identityFingerprint');
      expect(JSON.stringify(created)).not.toContain(INPUT.legalIdentity.identifier);
      const id = created.supplier.id;
      const submitted = await h.service.submit(id, 1, 'supplier-submit-001');
      expect(submitted.supplier.status).toBe('under_review');
      const decided = await h.service.decide(id, 2, 'supplier-decide-001', {
        outcome: 'approved', decisionEvidenceRef: 'approval-1', qualifications: [
          { type: 'identity', evidenceRef: 'identity-evidence', validUntil: '2027-12-31' },
          { type: 'contract_terms', evidenceRef: 'terms-evidence' },
          { type: 'tax_profile', evidenceRef: 'tax-evidence', validUntil: '2027-12-31' },
          { type: 'conflict_review', evidenceRef: 'conflict-evidence', validUntil: '2027-12-31' },
        ],
      });
      expect(decided.supplier).toMatchObject({ status: 'active', version: 3 });
      const eligibility = await h.service.resolveEligibility(id, { purpose: 'engagement_create', serviceCategoryCode: 'video_editing', at: '2026-09-01T00:00:00.000Z' });
      expect(eligibility.eligible).toBe(true);
      expect(h.outbox.append).toHaveBeenCalledTimes(3);
    });
  });

  it('重复法定身份在业务写入前冲突失败', async () => {
    const h = harness();
    await h.run(async () => {
      await h.service.createDraft('supplier-create-001', INPUT);
      await expect(h.service.createDraft('supplier-create-002', { ...INPUT, displayName: '另一供应方' })).rejects.toMatchObject({ response: { code: 'SUPPLIER_IDENTITY_DUPLICATE' } });
      expect(h.repository.insert).toHaveBeenCalledTimes(1);
    });
  });

  it('应用模块自身拒绝缺少 Scope，且不触达持久化或加密', async () => {
    const h = harness([]);
    await h.run(async () => {
      await expect(h.service.createDraft('supplier-create-001', INPUT)).rejects.toMatchObject({ response: { code: 'SUPPLIER_SCOPE_DENIED' } });
      expect(h.crypto.protect).not.toHaveBeenCalled(); expect(h.repository.insert).not.toHaveBeenCalled();
    });
  });

  it('责任部门不在数据范围时拒绝读取和写入', async () => {
    const h = harness();
    await h.run(async () => {
      await expect(h.service.createDraft('supplier-create-001', { ...INPUT, responsibleDepartmentId: 'department-2' })).rejects.toMatchObject({ response: { code: 'SUPPLIER_OWNER_INVALID' } });
      const created = await h.service.createDraft('supplier-create-002', INPUT);
      const value = h.values.get(created.supplier.id)!; h.values.set(value.id, { ...value, responsibleDepartmentId: 'department-2' });
      await expect(h.service.get(value.id)).rejects.toMatchObject({ response: { code: 'SUPPLIER_DATA_SCOPE_DENIED' } });
    });
  });

  it('强版本不匹配在状态变化和 Outbox 前失败', async () => {
    const h = harness();
    await h.run(async () => {
      const created = await h.service.createDraft('supplier-create-001', INPUT);
      await expect(h.service.submit(created.supplier.id, 9, 'supplier-submit-001')).rejects.toMatchObject({ response: { code: 'SUPPLIER_VERSION_CONFLICT' } });
      expect(h.repository.replace).not.toHaveBeenCalled(); expect(h.outbox.append).toHaveBeenCalledTimes(1);
    });
  });

  it('能力与价目经应用服务分别版本化并发布目录事件', async () => {
    const h = harness();
    await h.run(async () => {
      const created = await h.service.createDraft('supplier-create-001', INPUT);
      const capabilities = await h.service.replaceCapabilities(created.supplier.id, 1, 'supplier-capabilities-001', { capabilities: [{ serviceCategoryCode: 'video_editing', level: 'preferred' }] });
      expect(capabilities.supplier).toMatchObject({ version: 2, capabilities: [{ level: 'preferred' }] });
      const rates = await h.service.replaceRates(created.supplier.id, 2, 'supplier-rates-001', { rates: [{ serviceCategoryCode: 'video_editing', unit: 'per_project', amountMinor: '150000', currency: 'CNY', taxIncluded: true, validFrom: '2026-08-01' }] });
      expect(rates.supplier).toMatchObject({ version: 3, rates: [{ amountMinor: '150000' }] });
      expect(h.outbox.appendCatalog).toHaveBeenCalledTimes(2);
    });
  });

  it('系统任务在资质过期后冻结供应方并发布到期事件', async () => {
    const h = harness([...harnessScopes(), 'erp:supplier:qualification:review']);
    await h.run(async () => {
      const created = await h.service.createDraft('supplier-create-001', INPUT);
      await h.service.submit(created.supplier.id, 1, 'supplier-submit-001');
      await h.service.decide(created.supplier.id, 2, 'supplier-decide-001', {
        outcome: 'approved', decisionEvidenceRef: 'approval-1', qualifications: [
          { type: 'identity', evidenceRef: 'identity-evidence', validUntil: '2027-08-10' },
          { type: 'contract_terms', evidenceRef: 'terms-evidence' },
          { type: 'tax_profile', evidenceRef: 'tax-evidence', validUntil: '2027-08-10' },
          { type: 'conflict_review', evidenceRef: 'conflict-evidence', validUntil: '2027-08-10' },
        ],
      });
      await expect(h.service.reviewQualificationExpiry(created.supplier.id, 3, '2027-08-11', 'supplier-qualification-2027-08-11-test')).resolves.toMatchObject({ outcome: 'expired', version: 4 });
      expect(h.outbox.appendQualification).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' }), 'expired', '2027-08-10', expect.any(Array), '2027-08-11', session);
    });
  });
});

function harnessScopes(): string[] {
  return [
    'erp:supplier:relationship:write', 'erp:supplier:relationship:read',
    'erp:supplier:relationship:decide', 'erp:supplier:eligibility:read',
    'erp:supplier:catalog:write',
  ];
}
