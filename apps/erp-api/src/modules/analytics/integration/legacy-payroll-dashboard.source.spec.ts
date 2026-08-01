import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { LegacyPayrollBoundaryService } from '../../payroll/legacy-payroll-boundary.service.js';
import type { PayrollPeriodDocument } from '../../payroll/persistence/payroll.schemas.js';
import { LegacyPayrollDashboardSource } from './legacy-payroll-dashboard.source.js';

function latest(value: unknown) {
  return { sort: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) };
}

function fixture(input: {
  readonly legacy: boolean;
  readonly snapshot?: unknown;
}) {
  const boundary = { isLegacyEnabled: vi.fn(() => input.legacy) };
  const payrollPeriods = {
    findOne: vi.fn().mockReturnValue(latest(input.snapshot ?? null)),
  };
  return {
    boundary,
    payrollPeriods,
    source: new LegacyPayrollDashboardSource(
      boundary as unknown as LegacyPayrollBoundaryService,
      payrollPeriods as unknown as Model<PayrollPeriodDocument>,
    ),
  };
}

describe('LegacyPayrollDashboardSource', () => {
  it('external 模式在构造 Mongo 查询前返回禁用结果', async () => {
    const store = fixture({
      legacy: false,
      snapshot: { period: '2026-07', status: 'locked', employeeCount: 300 },
    });
    await expect(store.source.getLatest('tenant-001', '2026-07')).resolves.toEqual({
      enabled: false,
      snapshot: null,
    });
    expect(store.payrollPeriods.findOne).not.toHaveBeenCalled();
  });

  it('显式 legacy 模式按可信租户和口径月读取最小投影', async () => {
    const store = fixture({
      legacy: true,
      snapshot: { period: '2026-06', status: 'locked', employeeCount: 295 },
    });
    const result = await store.source.getLatest('tenant-001', '2026-07');
    expect(store.payrollPeriods.findOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', period: { $lte: '2026-07' } },
      { period: 1, status: 1, employeeCount: 1, _id: 0 },
    );
    expect(result).toEqual({
      enabled: true,
      snapshot: { period: '2026-06', status: 'locked', employeeCount: 295 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('legacy 模式缺少快照时保留启用状态且不伪造工资数据', async () => {
    const store = fixture({ legacy: true });
    await expect(store.source.getLatest('tenant-001', '2026-07')).resolves.toEqual({
      enabled: true,
      snapshot: null,
    });
  });
});
