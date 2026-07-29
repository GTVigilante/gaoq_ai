import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { LegacyPayrollBoundaryService } from './legacy-payroll-boundary.service.js';

function assemble(mode: 'external' | 'legacy' | undefined) {
  const get = vi.fn((key: keyof AppEnvironment) => {
    if (key === 'PAYROLL_SYSTEM_MODE') return mode;
    if (key === 'PAYROLL_WEB_ORIGIN') return 'https://payroll.example.com';
    return undefined;
  });
  const config = {
    get,
  } as unknown as ConfigService<AppEnvironment, true>;
  return { get, service: new LegacyPayrollBoundaryService(config) };
}

describe('LegacyPayrollBoundaryService', () => {
  it.each(['external', undefined] as const)(
    '%s 模式统一关闭旧工资与资金应用服务',
    (mode) => {
      const store = assemble(mode);
      let failure: unknown;
      try {
        store.service.assertLegacy();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        status: 410,
        response: {
          code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
          payrollWebOrigin: 'https://payroll.example.com',
        },
      });
    },
  );

  it('只有显式 legacy 模式允许旧事实源执行', () => {
    const store = assemble('legacy');
    expect(store.service.assertLegacy()).toBeUndefined();
    expect(store.get.mock.calls).toHaveLength(1);
  });
});
