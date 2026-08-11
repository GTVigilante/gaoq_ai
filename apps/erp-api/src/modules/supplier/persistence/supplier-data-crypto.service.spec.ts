import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { SupplierDataCryptoService } from './supplier-data-crypto.service.js';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');
const encryption = JSON.stringify({ activeKeyId: 'enc-v1', keys: [{ keyId: 'enc-v1', keyBase64url: key(1), status: 'active' }] });
const blind = JSON.stringify({ activeKeyId: 'blind-v1', keys: [{ keyId: 'blind-v1', keyBase64url: key(2), status: 'active' }, { keyId: 'blind-old', keyBase64url: key(3), status: 'lookup_only' }] });
const context = { tenantId: 'tenant-a', supplierId: '01K2A3B4C5D6E7F8G9H0JKMNPQ', version: 1 };
const identity = { identifierType: 'national_id' as const, identifier: '110101199001011234', legalName: '林一' };

function service(enc = encryption, idx = blind): SupplierDataCryptoService {
  return new SupplierDataCryptoService(new ConfigService<AppEnvironment, true>({ SUPPLIER_DATA_ENCRYPTION_KEYS: enc, SUPPLIER_BLIND_INDEX_KEYS: idx } as AppEnvironment));
}

describe('SupplierDataCryptoService', () => {
  it('使用上下文 AAD 加密并可精确解密规范身份', () => {
    const crypto = service(); const protectedValue = crypto.protect(context, identity);
    expect(protectedValue).toMatchObject({ keyId: 'enc-v1' });
    expect(crypto.unprotect(context, protectedValue)).toEqual(identity);
    expect(() => crypto.unprotect({ ...context, tenantId: 'tenant-b' }, protectedValue)).toThrow('SUPPLIER_IDENTITY_CIPHERTEXT_INVALID');
  });

  it('生成活动和轮换查询盲索引且不暴露证件', () => {
    const crypto = service(); const values = crypto.identityFingerprints('tenant-a', identity);
    expect(values).toHaveLength(2); expect(values[0]).toMatch(/^blind-v1\.[A-Za-z0-9_-]{43}$/);
    expect(values.join('')).not.toContain(identity.identifier);
    expect(crypto.identityHint(identity)).toBe('****1234');
  });

  it('缺失、复用或非法密钥和非法身份均失败关闭', () => {
    const missing = new SupplierDataCryptoService(new ConfigService<AppEnvironment, true>({} as AppEnvironment));
    expect(() => missing.protect(context, identity)).toThrow('SUPPLIER_KEY_RING_INVALID');
    const duplicate = JSON.stringify({ activeKeyId: 'same', keys: [{ keyId: 'same', keyBase64url: key(1), status: 'active' }, { keyId: 'same', keyBase64url: key(2), status: 'decrypt_only' }] });
    expect(() => service(duplicate).protect(context, identity)).toThrow('SUPPLIER_KEY_RING_INVALID');
    expect(() => service().protect(context, { ...identity, identifier: 'x' })).toThrow('SUPPLIER_LEGAL_IDENTITY_INVALID');
  });
});
