import { GoneException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { LegacyPayrollBoundaryGuard } from './legacy-payroll-boundary.guard.js';

const config = (mode: 'external' | 'legacy'): ConfigService<AppEnvironment, true> => ({
  get: (key: keyof AppEnvironment) => {
    if (key === 'PAYROLL_SYSTEM_MODE') return mode;
    if (key === 'PAYROLL_WEB_ORIGIN') return 'https://payroll.example.com';
    return undefined;
  },
} as unknown as ConfigService<AppEnvironment, true>);

describe('ERP 旧工资事实源边界', () => {
  it('external 模式关闭旧 Payroll/Treasury REST 入口', () => {
    const guard = new LegacyPayrollBoundaryGuard(config('external'));
    expect(() => guard.canActivate()).toThrow(GoneException);
  });

  it('显式 legacy 模式只用于非生产回溯', () => {
    const guard = new LegacyPayrollBoundaryGuard(config('legacy'));
    expect(guard.canActivate()).toBe(true);
  });
});
