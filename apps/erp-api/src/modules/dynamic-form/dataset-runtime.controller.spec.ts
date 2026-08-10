import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { DatasetRuntimeService } from './runtime/dataset-runtime.service.js';
import { DatasetRuntimeController } from './dataset-runtime.controller.js';

describe('联邦数据集 REST Interface', () => {
  it('解析记录后只审计引用、版本和字段数，不记录字段正文', async () => {
    const resolve = vi.fn().mockResolvedValue({
      ref: { dataset: { kind: 'external', system: 'op', objectType: 'operating_summary', schemaVersion: '1.0' }, recordId: '2026-08-09', version: '4' },
      values: { summaryDate: '2026-08-09', gmvMinor: '120001' }, observedAt: '2026-08-10T00:00:00.000Z',
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new DatasetRuntimeController({ resolve } as unknown as DatasetRuntimeService, { record } as unknown as AuditService);
    await expect(controller.resolve({ record: { dataset: {}, recordId: '' } })).resolves.toMatchObject({ ref: { version: '4' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dataset.record.resolve', resourceId: '2026-08-09',
      metadata: { sourceKind: 'external', recordVersion: '4', fieldCount: 2 },
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('120001');
  });

  it('敏感读取审计不可用时失败关闭', async () => {
    const runtime = { resolve: vi.fn().mockResolvedValue({ ref: { dataset: { kind: 'native' }, recordId: 'record-1', version: '1' }, values: {}, observedAt: '2026-08-10T00:00:00.000Z' }) };
    const audit = { record: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
    const controller = new DatasetRuntimeController(runtime as unknown as DatasetRuntimeService, audit as unknown as AuditService);
    await expect(controller.resolve({ record: {} })).rejects.toThrow('audit unavailable');
  });
});
