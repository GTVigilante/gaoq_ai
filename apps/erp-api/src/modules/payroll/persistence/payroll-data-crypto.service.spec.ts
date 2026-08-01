import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  type ProtectedPayrollData,
  PayrollDataCryptoService,
} from './payroll-data-crypto.service.js';

function fromRaw(raw: string | undefined): PayrollDataCryptoService {
  return new PayrollDataCryptoService(new ConfigService<AppEnvironment, true>({
    PAYROLL_DATA_ENCRYPTION_KEYS: raw,
  } as AppEnvironment));
}

function fromRing(ring: unknown): PayrollDataCryptoService {
  return fromRaw(JSON.stringify(ring));
}

function key(
  keyId: string,
  status: 'active' | 'decrypt_only',
  keyBase64url = randomBytes(32).toString('base64url'),
) {
  return { keyId, keyBase64url, status };
}

function service(): PayrollDataCryptoService {
  return fromRing({
    activeKeyId: 'payroll-key-001',
    keys: [key('payroll-key-001', 'active')],
  });
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
    expect(Object.isFrozen(protectedData)).toBe(true);
    expect(Buffer.from(protectedData.iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(protectedData.authTag, 'base64url')).toHaveLength(16);
    expect(crypto.unprotect(context, protectedData)).toEqual({ baseSalaryMinor: 1_000_000 });
    for (const changed of [
      { ...context, tenantId: 'tenant-002' },
      { ...context, resourceType: 'tax_filing' as const },
      { ...context, resourceId: 'profile-002' },
      { ...context, version: 2 },
    ]) {
      expect(() => crypto.unprotect(changed, protectedData))
        .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
    }
  });

  it('上下文的租户、资源、版本与资源类型均严格失败关闭', () => {
    const crypto = service();
    for (const invalid of [
      { ...context, tenantId: 'bad/tenant' },
      { ...context, resourceId: '' },
      { ...context, version: 0 },
      { ...context, version: 1.5 },
      { ...context, resourceType: 'bank_account' },
    ]) {
      expect(() => crypto.protect(invalid as typeof context, {}))
        .toThrow('PAYROLL_DATA_CONTEXT_INVALID');
    }
  });

  it('密钥环缺失、非法 JSON、重复标识和活动状态冲突均稳定失败关闭', () => {
    const secret = randomBytes(32).toString('base64url');
    const invalidRings = [
      undefined,
      '',
      '{not-json',
      JSON.stringify({ activeKeyId: 'key-1', keys: [] }),
      JSON.stringify({
        activeKeyId: 'key-1',
        keys: [key('key-1', 'active', secret), key('key-1', 'decrypt_only', secret)],
      }),
      JSON.stringify({
        activeKeyId: 'key-1',
        keys: [key('key-1', 'active'), key('key-2', 'active')],
      }),
      JSON.stringify({
        activeKeyId: 'key-2',
        keys: [key('key-1', 'active'), key('key-2', 'decrypt_only')],
      }),
    ];
    for (const raw of invalidRings) {
      expect(() => fromRaw(raw).protect(context, {}))
        .toThrow('PAYROLL_DATA_KEY_RING_INVALID');
    }
  });

  it('非规范主密钥稳定归类为密钥环错误且不误报密文错误', () => {
    const noncanonical = `${'A'.repeat(42)}B`;
    const crypto = fromRing({
      activeKeyId: 'key-1',
      keys: [key('key-1', 'active', noncanonical)],
    });
    expect(() => crypto.protect(context, {})).toThrow('PAYROLL_DATA_KEY_RING_INVALID');
  });

  it('密钥轮换只用活动密钥加密并允许 decrypt_only 历史密钥解密', () => {
    const oldSecret = randomBytes(32).toString('base64url');
    const newSecret = randomBytes(32).toString('base64url');
    const oldCrypto = fromRing({
      activeKeyId: 'key-old',
      keys: [key('key-old', 'active', oldSecret)],
    });
    const oldProtected = oldCrypto.protect(context, { amount: 100 });
    const rotated = fromRing({
      activeKeyId: 'key-new',
      keys: [
        key('key-new', 'active', newSecret),
        key('key-old', 'decrypt_only', oldSecret),
      ],
    });
    expect(rotated.unprotect(context, oldProtected)).toEqual({ amount: 100 });
    expect(rotated.protect(context, { amount: 200 }).keyId).toBe('key-new');
    const withoutOld = fromRing({
      activeKeyId: 'key-new',
      keys: [key('key-new', 'active', newSecret)],
    });
    expect(() => withoutOld.unprotect(context, oldProtected))
      .toThrow('PAYROLL_DATA_KEY_UNAVAILABLE');
  });

  it('密文元数据、规范编码、固定长度和认证标签任一异常均拒绝解密', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, { amount: 100 });
    const invalid: readonly Partial<ProtectedPayrollData>[] = [
      { ...protectedData, keyId: 'bad/key' },
      { ...protectedData, iv: '' },
      { ...protectedData, iv: `${protectedData.iv}A` },
      { ...protectedData, ciphertext: '' },
      { ...protectedData, ciphertext: `${protectedData.ciphertext}=` },
      { ...protectedData, authTag: '' },
      { ...protectedData, authTag: `${protectedData.authTag}A` },
      { ...protectedData, authTag: `${protectedData.authTag.slice(0, -1)}B` },
    ];
    for (const candidate of invalid) {
      expect(() => crypto.unprotect(context, candidate as ProtectedPayrollData))
        .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
    }
    expect(() => crypto.unprotect(context, null as never))
      .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
    expect(() => crypto.unprotect(context, undefined as never))
      .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
  });

  it('密文篡改和不可序列化明文统一映射为稳定错误', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, { amount: 100 });
    const replacement = protectedData.ciphertext.startsWith('A') ? 'B' : 'A';
    expect(() => crypto.unprotect(context, {
      ...protectedData,
      ciphertext: `${replacement}${protectedData.ciphertext.slice(1)}`,
    })).toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
    expect(() => crypto.protect(context, { amount: 1n }))
      .toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
  });

  it('明文和外部密文都在八 MiB 边界失败关闭', () => {
    const crypto = service();
    expect(() => crypto.protect(context, 'x'.repeat(8 * 1024 * 1024)))
      .toThrow('PAYROLL_DATA_TOO_LARGE');
    const protectedData = crypto.protect(context, { amount: 100 });
    expect(() => crypto.unprotect(context, {
      ...protectedData,
      ciphertext: 'A'.repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3) + 1),
    })).toThrow('PAYROLL_DATA_CIPHERTEXT_INVALID');
  });
});
