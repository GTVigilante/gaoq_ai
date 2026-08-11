import { describe, expect, it } from 'vitest';

import { parseEngagementOperationsSearch, parsePayableOperationsSearch } from './supplier-operations-contract';

const ENGAGEMENT = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', engagementNumber: 'ENG-6P8R0T2W4Y',
  sourcingRequestId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7', supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
  serviceCategoryCode: 'video_editing', agreedAmountMinor: '400000', currency: 'CNY',
  responsibleDepartmentId: 'department-1', ownerEmployeeId: 'employee-1',
  performerRefs: ['performer-1'], deliveries: [{ version: 1, submittedAt: '2026-08-11T01:00:00.000Z' }],
  status: 'delivered', statusReasonCode: null, version: 5,
  createdAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z',
};
const PAYABLE = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', payableNumber: 'PAY-6P8R0T2W4Y',
  engagementId: ENGAGEMENT.id, engagementVersion: 6, supplierId: ENGAGEMENT.supplierId,
  grossAmountMinor: '400000', withholdingAmountMinor: '32000', netAmountMinor: '368000',
  currency: 'CNY', taxTreatmentCode: 'individual_service', treasuryInstructionRef: null,
  status: 'approved', failureCode: null, version: 3,
  createdAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z',
};

describe('供应方履约结算浏览器契约', () => {
  it('解析严格履约和应付列表', () => {
    expect(parseEngagementOperationsSearch({ items: [ENGAGEMENT], nextCursor: null }).items[0]?.status).toBe('delivered');
    expect(parsePayableOperationsSearch({ items: [PAYABLE], nextCursor: null }).items[0]?.netAmountMinor).toBe('368000');
  });
  it('拒绝未知字段、错序交付和净额漂移', () => {
    expect(() => parseEngagementOperationsSearch({ items: [{ ...ENGAGEMENT, extra: true }], nextCursor: null })).toThrow('ENGAGEMENT_RESPONSE_INVALID');
    expect(() => parseEngagementOperationsSearch({ items: [{ ...ENGAGEMENT, deliveries: [{ version: 2, submittedAt: ENGAGEMENT.updatedAt }] }], nextCursor: null })).toThrow('ENGAGEMENT_RESPONSE_INVALID');
    expect(() => parsePayableOperationsSearch({ items: [{ ...PAYABLE, netAmountMinor: '368001' }], nextCursor: null })).toThrow('PAYABLE_RESPONSE_INVALID');
  });
});
