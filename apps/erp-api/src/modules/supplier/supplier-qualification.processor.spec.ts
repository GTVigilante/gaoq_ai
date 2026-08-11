import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { SupplierQualificationProcessor } from './supplier-qualification.processor.js';
import {
  SUPPLIER_QUALIFICATION_SCAN_JOB,
  type SupplierQualificationScanJobData,
} from './supplier-qualification.queue.js';

function setup() {
  const context = { run: vi.fn((_trusted: unknown, callback: () => Promise<unknown>) => callback()) };
  const scan = { listCandidates: vi.fn()
    .mockResolvedValueOnce([{ tenantId: 'tenant-a', supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9', version: 3 }]) };
  const suppliers = { reviewQualificationExpiry: vi.fn().mockResolvedValue({
    outcome: 'expired', supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9', version: 4,
  }) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    context, scan, suppliers, audit,
    processor: new SupplierQualificationProcessor(
      context as never, scan as never, suppliers as never, audit as never,
    ),
  };
}

function job(name = SUPPLIER_QUALIFICATION_SCAN_JOB, data: SupplierQualificationScanJobData = {}) {
  return { id: 'qualification-scan-1', name, data } as Job<SupplierQualificationScanJobData>;
}

describe('SupplierQualificationProcessor', () => {
  it('只传递可信候选标识，并在租户系统身份内复核', async () => {
    const value = setup();
    await expect(value.processor.process(job())).resolves.toBe(1);
    expect(value.context.run).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: { tenantId: 'tenant-a', source: 'service_identity' } }),
      expect.any(Function),
    );
    expect(value.suppliers.reviewQualificationExpiry).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y9', 3, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      expect.stringContaining('supplier-qualification-'),
    );
  });

  it('拒绝未知任务和带载荷的全局扫描', async () => {
    const value = setup();
    await expect(value.processor.process(job('unknown'))).rejects.toThrow('SUPPLIER_QUALIFICATION_SCAN_JOB_INVALID');
    await expect(value.processor.process(job(SUPPLIER_QUALIFICATION_SCAN_JOB, { injected: true })))
      .rejects.toThrow('SUPPLIER_QUALIFICATION_SCAN_JOB_INVALID');
    expect(value.scan.listCandidates).not.toHaveBeenCalled();
  });
});
