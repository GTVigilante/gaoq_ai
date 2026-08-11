import { describe, expect, it } from 'vitest';
import { parseSupplierSearch, parseSupplierWrite } from './supplier-contract';

const supplier = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y9', supplierNumber: 'SUP-6P8R0T2W4Y', partyKind: 'individual', legalForm: 'individual',
  displayName: '林一工作室', identityHint: '****1234', ownerEmployeeId: 'employee-1', responsibleDepartmentId: 'department-1',
  riskTier: 'medium', status: 'active', capabilities: [{ serviceCategoryCode: 'video_editing', level: 'verified', evidenceRef: null, validUntil: '2027-12-31' }],
  rates: [{ serviceCategoryCode: 'video_editing', unit: 'per_project', amountMinor: '120000', currency: 'CNY', taxIncluded: true, validFrom: '2026-08-01', validUntil: null }],
  qualifications: [{ type: 'identity', verifiedAt: '2026-08-11T00:00:00.000Z', validUntil: '2027-12-31' }], statusReasonCode: null,
  version: 3, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:02:00.000Z',
};

describe('supplier browser contract', () => {
  it('解析有界供应方名册与写响应', () => {
    expect(parseSupplierSearch({ items: [supplier], nextCursor: null }).items[0]?.displayName).toBe('林一工作室');
    expect(parseSupplierWrite({ supplier }).supplier.version).toBe(3);
  });
  it('拒绝未知字段、浮点金额语义、重复记录和自定义原型', () => {
    expect(() => parseSupplierSearch({ items: [{ ...supplier, secret: 'x' }], nextCursor: null })).toThrow('SUPPLIER_BROWSER_CONTRACT_INVALID');
    expect(() => parseSupplierSearch({ items: [{ ...supplier, rates: [{ ...supplier.rates[0], amountMinor: '12.50' }] }], nextCursor: null })).toThrow('SUPPLIER_BROWSER_CONTRACT_INVALID');
    expect(() => parseSupplierSearch({ items: [supplier, supplier], nextCursor: null })).toThrow('SUPPLIER_BROWSER_CONTRACT_INVALID');
    expect(() => parseSupplierSearch(Object.assign(Object.create({}), { items: [], nextCursor: null }))).toThrow('SUPPLIER_BROWSER_CONTRACT_INVALID');
  });
});
