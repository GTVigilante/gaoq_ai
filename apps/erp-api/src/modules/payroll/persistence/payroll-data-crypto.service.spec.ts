import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { PayrollDataCryptoService } from './payroll-data-crypto.service.js';

function service(): PayrollDataCryptoService {
  return new PayrollDataCryptoService(new ConfigService<AppEnvironment, true>({
    PAYROLL_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'payroll-key-001',
      keys: [{
        keyId: 'payroll-key-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
  } as AppEnvironment));
}

const context = {
  tenantId: 'tenant-001', resourceType: 'compensation_profile' as const,
  resourceId: 'profile-001', version: 1,
};

describe('PayrollDataCryptoService', () => {
  it('AES-GCM 往返且 AAD 绑定租户、资源、标识和版本', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, { baseSalaryMinor: 1_000_000 });
    expect(JSON.stringify(protectedData)).not.toContain('1000000');
    expect(crypto.unprotect(context, protectedData)).toEqual({ baseSalaryMinor: 1_000_000 });
    expect(() => crypto.unprotect({ ...context, tenantId: 'tenant-002' }, protectedData))
      .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
    expect(() => crypto.unprotect({ ...context, version: 2 }, protectedData))
      .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
  });

  it('密钥环缺失时失败关闭且不回显配置内容', () => {
    const crypto = new PayrollDataCryptoService(new ConfigService<AppEnvironment, true>({
      PAYROLL_DATA_ENCRYPTION_KEYS: '',
    } as AppEnvironment));
    expect(() => crypto.protect(context, {})).toThrow('PAYROLL_DATA_KEY_RING_INVALID');
  });
});
