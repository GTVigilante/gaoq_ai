import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import { PayrollDataCryptoService } from './payroll-data-crypto.service.js';

const dataKey = Buffer.alloc(32, 1).toString('base64');
const blindKey = Buffer.alloc(32, 2).toString('base64');
const config = {
  get: (name: keyof AppEnvironment) => {
    if (name === 'PAYROLL_DATA_ENCRYPTION_KEYS') {
      return JSON.stringify([{
        keyId: 'payroll-data-2026-01',
        keyBase64: dataKey,
        status: 'active',
      }]);
    }
    if (name === 'PAYROLL_BLIND_INDEX_KEYS') {
      return JSON.stringify([{
        keyId: 'payroll-blind-2026-01',
        keyBase64: blindKey,
        status: 'active',
      }]);
    }
    return undefined;
  },
} as unknown as ConfigService<AppEnvironment, true>;

describe('薪酬 L4 数据加密', () => {
  it('使用租户和资源 AAD 加密并认证解密', () => {
    const crypto = new PayrollDataCryptoService(config);
    const context = {
      tenantId: 'tenant-001',
      resourceType: 'payroll_result',
      resourceId: 'result-001',
      version: 1,
    };
    const protectedValue = crypto.protect(context, {
      employeeId: 'employee-001',
      netMinor: '1000000',
    });
    expect(protectedValue.ciphertext).not.toContain('employee-001');
    expect(crypto.unprotect(context, protectedValue)).toEqual({
      employeeId: 'employee-001',
      netMinor: '1000000',
    });
    expect(() => crypto.unprotect(
      { ...context, tenantId: 'tenant-002' },
      protectedValue,
    )).toThrow('认证失败');
  });

  it('员工盲索引绑定租户且不泄漏原始主键', () => {
    const crypto = new PayrollDataCryptoService(config);
    const first = crypto.employeeBlindIndex('tenant-001', 'employee-001');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain('employee-001');
    expect(crypto.employeeBlindIndex('tenant-002', 'employee-001')).not.toBe(first);
  });
});
