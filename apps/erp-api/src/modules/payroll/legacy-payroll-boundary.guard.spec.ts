import { describe, expect, it, vi } from 'vitest';

import { LegacyPayrollBoundaryGuard } from './legacy-payroll-boundary.guard.js';

describe('ERP 旧工资事实源边界', () => {
  it('external 模式关闭旧 Payroll/Treasury REST 入口', () => {
    const error = new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
    const boundary = { assertLegacy: vi.fn(() => { throw error; }) };
    const guard = new LegacyPayrollBoundaryGuard(boundary as never);
    expect(() => guard.canActivate()).toThrow(error);
  });

  it('显式 legacy 模式只用于非生产回溯', () => {
    const boundary = { assertLegacy: vi.fn() };
    const guard = new LegacyPayrollBoundaryGuard(boundary as never);
    expect(guard.canActivate()).toBe(true);
    expect(boundary.assertLegacy).toHaveBeenCalledOnce();
  });
});
