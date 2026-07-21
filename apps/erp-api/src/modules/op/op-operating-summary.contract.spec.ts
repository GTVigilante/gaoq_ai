import { describe, expect, it } from 'vitest';

import {
  hashOpPayload,
  opOperatingSummaryEnvelopeSchema,
} from './op-operating-summary.contract.js';

const valid = {
  schemaVersion: '1.0', type: 'operating.summary.published',
  occurredAt: '2026-07-22T08:00:00.000Z',
  data: {
    summaryDate: '2026-07-22', revision: 1, currency: 'CNY',
    metrics: {
      gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
      refundOrderCount: 1, activeCustomerCount: 8,
    },
  },
};

describe('OP 经营摘要契约', () => {
  it('仅接受固定指标、安全整数分与严格信封', () => {
    expect(opOperatingSummaryEnvelopeSchema.parse(valid)).toEqual(valid);
    expect(() => opOperatingSummaryEnvelopeSchema.parse({
      ...valid, tenantId: 'forged-tenant',
    })).toThrow();
    expect(() => opOperatingSummaryEnvelopeSchema.parse({
      ...valid, data: {
        ...valid.data, metrics: { ...valid.data.metrics, dynamicMetric: 1 },
      },
    })).toThrow();
    expect(() => opOperatingSummaryEnvelopeSchema.parse({
      ...valid, data: {
        ...valid.data, metrics: { ...valid.data.metrics, gmvMinor: 1.5 },
      },
    })).toThrow();
  });

  it('载荷摘要绑定原始字节而不是重排后的 JSON', () => {
    const first = Buffer.from('{"a":1,"b":2}');
    const second = Buffer.from('{"b":2,"a":1}');
    expect(hashOpPayload(first)).toHaveLength(43);
    expect(hashOpPayload(first)).not.toBe(hashOpPayload(second));
  });
});
