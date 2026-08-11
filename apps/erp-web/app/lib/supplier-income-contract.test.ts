import { describe, expect, it } from 'vitest';

import { parseSupplierIncome } from './supplier-income-contract';

const ITEM = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', payableNumber: 'PAY-6P8R0T2W4Y',
  engagementId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7', grossAmountMinor: '400000',
  withholdingAmountMinor: '32000', netAmountMinor: '368000', currency: 'CNY',
  status: 'paid', failureCode: null, updatedAt: '2026-08-11T01:00:00.000Z',
};

describe('供应方收益浏览器契约', () => {
  it('接受金额闭合的最小收益投影', () => {
    expect(parseSupplierIncome({
      summary: {
        grossAmountMinor: '400000', withholdingAmountMinor: '32000',
        netAmountMinor: '368000', awaitingAmountMinor: '0', processingAmountMinor: '0',
        paidAmountMinor: '368000', attentionAmountMinor: '0', currency: 'CNY', itemCount: 1,
      }, items: [ITEM],
    }).summary.paidAmountMinor).toBe('368000');
  });

  it('拒绝汇总漂移、额外字段和浮点金额', () => {
    const valid = {
      summary: {
        grossAmountMinor: '400000', withholdingAmountMinor: '32000',
        netAmountMinor: '368000', awaitingAmountMinor: '0', processingAmountMinor: '0',
        paidAmountMinor: '368000', attentionAmountMinor: '0', currency: 'CNY', itemCount: 1,
      }, items: [ITEM],
    };
    expect(() => parseSupplierIncome({
      ...valid, summary: { ...valid.summary, paidAmountMinor: '367999' },
    })).toThrow('SUPPLIER_INCOME_BROWSER_CONTRACT_INVALID');
    expect(() => parseSupplierIncome({ ...valid, unexpected: true })).toThrow();
    expect(() => parseSupplierIncome({
      ...valid, items: [{ ...ITEM, netAmountMinor: '3680.00' }],
    })).toThrow();
  });
});
