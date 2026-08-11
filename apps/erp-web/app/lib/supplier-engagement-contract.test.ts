import { describe, expect, it } from 'vitest';

import { parseSupplierEngagementList, parseSupplierEngagementWrite } from './supplier-engagement-contract';

const ENGAGEMENT = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', engagementNumber: 'ENG-6P8R0T2W4Y',
  serviceCategoryCode: 'video_editing', agreedAmountMinor: '400000', currency: 'CNY',
  status: 'active', deliveryCount: 0, version: 4,
  createdAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z',
};

describe('本人履约浏览器契约', () => {
  it('解析列表和交付写响应', () => {
    expect(parseSupplierEngagementList({ items: [ENGAGEMENT], nextCursor: null }).items[0]?.status).toBe('active');
    expect(parseSupplierEngagementWrite({ engagement: ENGAGEMENT }).engagement.version).toBe(4);
  });
  it('拒绝浮点金额、重复记录和额外字段', () => {
    expect(() => parseSupplierEngagementList({ items: [{ ...ENGAGEMENT, agreedAmountMinor: '4000.00' }], nextCursor: null })).toThrow();
    expect(() => parseSupplierEngagementList({ items: [ENGAGEMENT, ENGAGEMENT], nextCursor: null })).toThrow();
    expect(() => parseSupplierEngagementWrite({ engagement: { ...ENGAGEMENT, supplierId: 'hidden' } })).toThrow();
  });
});
