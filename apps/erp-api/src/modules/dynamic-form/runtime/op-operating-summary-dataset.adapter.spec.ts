import { describe, expect, it, vi } from 'vitest';

import type { OpOperatingSummaryService } from '../../op/application/op-operating-summary.service.js';
import { OpOperatingSummaryDatasetAdapter } from './op-operating-summary-dataset.adapter.js';

const REF = { kind: 'external' as const, system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' };

describe('OP 经营摘要数据集 Adapter', () => {
  it('保留 OP 事实源并转换为统一整数分值', async () => {
    const getLatest = vi.fn().mockResolvedValue({
      summaryDate: '2026-08-09', revision: 4, currency: 'CNY',
      metrics: { gmvMinor: 120001, paidOrderCount: 8, refundMinor: 300, refundOrderCount: 1, activeCustomerCount: 6 },
    });
    const adapter = new OpOperatingSummaryDatasetAdapter({ getLatest } as unknown as OpOperatingSummaryService);
    expect((await adapter.catalog())[0]).toMatchObject({ ref: REF, capabilities: { query: 'exact' } });
    const result = await adapter.resolve({ dataset: REF, recordId: '2026-08-09' });
    expect(getLatest).toHaveBeenCalledWith('2026-08-09');
    expect(result).toMatchObject({
      recordId: '2026-08-09', version: '4',
      values: { gmvMinor: '120001', refundMinor: '300', paidOrderCount: 8 },
    });
    await expect(adapter.query({
      dataset: REF, filters: [{ fieldKey: 'summaryDate', operator: 'eq', value: '2026-08-09' }], limit: 10,
    })).resolves.toHaveLength(1);
  });

  it('只接受登记的 OP 对象和 Schema 版本', async () => {
    const adapter = new OpOperatingSummaryDatasetAdapter({} as OpOperatingSummaryService);
    expect(adapter.accepts({ ...REF, schemaVersion: '2.0' })).toBe(false);
    await expect(adapter.describe({ ...REF, objectType: 'orders' })).rejects.toThrow('OP 数据集不存在');
  });
});
