import { describe, expect, it } from 'vitest';

import {
  approveSupplier, closeSupplier, createSupplierDraft, reactivateSupplier, rejectSupplier,
  replaceSupplierCapabilities, replaceSupplierRates, resolveSupplierEligibility, reviseSupplierDraft, submitSupplier, suspendSupplier,
  reviewSupplierQualificationExpiry,
  type SupplierDraftInput, type SupplierQualification,
} from './supplier.js';

const NOW = new Date('2026-08-10T08:00:00.000Z');
const BASE: SupplierDraftInput = {
  id: '01K2A3B4C5D6E7F8G9H0JKMNPQ',
  tenantId: 'tenant-a',
  supplierNumber: 'SUP-H0JKMNPQRS',
  partyKind: 'individual',
  legalForm: 'individual',
  displayName: '  林一工作室  ',
  identityFingerprint: `blind-v1.${'a'.repeat(43)}`,
  identityHint: '****1234',
  ownerEmployeeId: 'employee-1',
  responsibleDepartmentId: 'department-1',
  riskTier: 'medium',
  capabilities: [{ serviceCategoryCode: 'video_editing', level: 'verified', evidenceRef: 'evidence-capability', validUntil: '2027-12-31' }],
  rates: [{ serviceCategoryCode: 'video_editing', unit: 'per_project', amountMinor: '120000', currency: 'CNY', taxIncluded: true, validFrom: '2026-08-01', validUntil: null }],
};
const QUALIFICATIONS: readonly SupplierQualification[] = [
  { type: 'identity', evidenceRef: 'evidence-identity', verifiedAt: NOW.toISOString(), validUntil: '2027-08-10' },
  { type: 'contract_terms', evidenceRef: 'evidence-terms', verifiedAt: NOW.toISOString(), validUntil: null },
  { type: 'tax_profile', evidenceRef: 'evidence-tax', verifiedAt: NOW.toISOString(), validUntil: '2027-08-10' },
  { type: 'conflict_review', evidenceRef: 'evidence-conflict', verifiedAt: NOW.toISOString(), validUntil: '2027-08-10' },
];

describe('Supplier 领域', () => {
  it('创建规范化、冻结且使用整数分字符串的个人供应方草稿', () => {
    const supplier = createSupplierDraft(BASE, NOW);
    expect(supplier).toMatchObject({ displayName: '林一工作室', status: 'draft', version: 1 });
    expect(supplier.rates[0]?.amountMinor).toBe('120000');
    expect(Object.isFrozen(supplier)).toBe(true);
    expect(Object.isFrozen(supplier.capabilities)).toBe(true);
  });

  it('完成提交、批准、暂停和恢复状态机并生成资格快照', () => {
    const submitted = submitSupplier(createSupplierDraft(BASE, NOW), new Date('2026-08-10T08:01:00.000Z'));
    const active = approveSupplier(submitted, QUALIFICATIONS, 'approval-1', new Date('2026-08-10T08:02:00.000Z'));
    const eligible = resolveSupplierEligibility(active, 'engagement_create', 'video_editing', new Date('2026-09-01T00:00:00.000Z'));
    expect(eligible).toMatchObject({ eligible: true, reasonCodes: [], supplierVersion: 3 });
    expect(eligible.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const suspended = suspendSupplier(active, 'risk_review', new Date('2026-08-10T08:03:00.000Z'));
    expect(resolveSupplierEligibility(suspended, 'engagement_create', 'video_editing', NOW).reasonCodes).toContain('supplier_not_active');
    expect(reactivateSupplier(suspended, 'approval-2', new Date('2026-08-10T08:04:00.000Z')).status).toBe('active');
  });

  it('组织供应方必须具有组织专用准入结论', () => {
    const draft = createSupplierDraft({ ...BASE, partyKind: 'organization', legalForm: 'company' }, NOW);
    const submitted = submitSupplier(draft, NOW);
    expect(() => approveSupplier(submitted, QUALIFICATIONS, 'approval-1', NOW)).toThrow('SUPPLIER_QUALIFICATION_INCOMPLETE');
  });

  it('拒绝主体/法律形态错配、重复能力、浮点金额和受损日期', () => {
    expect(() => createSupplierDraft({ ...BASE, partyKind: 'organization' }, NOW)).toThrow('SUPPLIER_PARTY_LEGAL_FORM_MISMATCH');
    expect(() => createSupplierDraft({ ...BASE, capabilities: [...BASE.capabilities, ...BASE.capabilities] }, NOW)).toThrow('SUPPLIER_CAPABILITY_DUPLICATE');
    expect(() => createSupplierDraft({ ...BASE, rates: [{ ...BASE.rates[0]!, amountMinor: '12.5' }] }, NOW)).toThrow('SUPPLIER_RATE_AMOUNT_INVALID');
    expect(() => createSupplierDraft({ ...BASE, rates: [{ ...BASE.rates[0]!, validFrom: '2026-02-30' }] }, NOW)).toThrow('SUPPLIER_DATE_INVALID');
  });

  it('只允许草稿修订并拒绝时间倒退和版本上溢', () => {
    const draft = createSupplierDraft(BASE, NOW);
    expect(reviseSupplierDraft(draft, { ...BASE, displayName: '新名称' }, new Date('2026-08-10T08:01:00.000Z')).version).toBe(2);
    expect(() => reviseSupplierDraft(submitSupplier(draft, NOW), BASE, NOW)).toThrow('SUPPLIER_DRAFT_STATE_INVALID');
    expect(() => submitSupplier({ ...draft, version: Number.MAX_SAFE_INTEGER }, NOW)).toThrow('SUPPLIER_VERSION_INVALID');
    expect(() => submitSupplier(draft, new Date('2026-08-09T00:00:00.000Z'))).toThrow('SUPPLIER_TIME_REGRESSION');
  });

  it('拒绝缺失准入、过期能力和过期资质', () => {
    const active = approveSupplier(submitSupplier(createSupplierDraft(BASE, NOW), NOW), QUALIFICATIONS, 'approval-1', NOW);
    const snapshot = resolveSupplierEligibility(active, 'engagement_create', 'video_editing', new Date('2028-01-01T00:00:00.000Z'));
    expect(snapshot.eligible).toBe(false);
    expect(snapshot.reasonCodes).toEqual(expect.arrayContaining(['capability_expired', 'qualification_identity_expired']));
  });

  it('能力与参考价目独立版本化，且不能移除仍被价目引用的能力', () => {
    const draft = createSupplierDraft(BASE, NOW);
    const rateUpdated = replaceSupplierRates(draft, [{ ...BASE.rates[0]!, amountMinor: '150000' }], new Date('2026-08-10T08:01:00.000Z'));
    expect(rateUpdated).toMatchObject({ version: 2, rates: [{ amountMinor: '150000' }] });
    const capabilityUpdated = replaceSupplierCapabilities(rateUpdated, [{ ...BASE.capabilities[0]!, level: 'preferred' }], new Date('2026-08-10T08:02:00.000Z'));
    expect(capabilityUpdated).toMatchObject({ version: 3, capabilities: [{ level: 'preferred' }] });
    expect(() => replaceSupplierCapabilities(draft, [{ serviceCategoryCode: 'copywriting', level: 'basic', evidenceRef: null, validUntil: null }], NOW)).toThrow('SUPPLIER_RATE_INVALID');
    expect(() => replaceSupplierRates(submitSupplier(draft, NOW), [], NOW)).toThrow('SUPPLIER_RATE_STATE_INVALID');
  });

  it('拒绝是终态，关闭保留稳定原因码', () => {
    const submitted = submitSupplier(createSupplierDraft(BASE, NOW), NOW);
    const rejected = rejectSupplier(submitted, 'approval-1', 'identity_mismatch', NOW);
    expect(rejected).toMatchObject({ status: 'rejected', statusReasonCode: 'identity_mismatch' });
    expect(() => closeSupplier(rejected, 'manual_close', NOW)).toThrow('SUPPLIER_CLOSE_STATE_INVALID');
    expect(closeSupplier(createSupplierDraft(BASE, NOW), 'duplicate_record', NOW).status).toBe('closed');
  });

  it('只在固定提醒日产生到期预警，并在过期后要求冻结', () => {
    const active = approveSupplier(submitSupplier(createSupplierDraft(BASE, NOW), NOW), QUALIFICATIONS, 'approval-1', NOW);
    expect(reviewSupplierQualificationExpiry(active, '2027-07-11')).toMatchObject({
      kind: 'expiring', effectiveOn: '2027-08-10',
    });
    expect(reviewSupplierQualificationExpiry(active, '2027-07-12')).toBeNull();
    expect(reviewSupplierQualificationExpiry(active, '2027-08-11')).toMatchObject({
      kind: 'expired', effectiveOn: '2027-08-10',
    });
  });
});
