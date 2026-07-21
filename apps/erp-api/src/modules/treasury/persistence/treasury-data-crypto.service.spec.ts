import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { TreasuryDataCryptoService } from './treasury-data-crypto.service.js';

function key(): string { return randomBytes(32).toString('base64url'); }

function service(input?: {
  readonly encryptionKeys?: readonly string[];
  readonly blindKeys?: readonly string[];
}): TreasuryDataCryptoService {
  const encryptionKeys = input?.encryptionKeys ?? [key()];
  const blindKeys = input?.blindKeys ?? [key()];
  return new TreasuryDataCryptoService(new ConfigService<AppEnvironment, true>({
    TREASURY_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'treasury-key-001',
      keys: encryptionKeys.map((keyBase64url, index) => ({
        keyId: `treasury-key-${String(index + 1).padStart(3, '0')}`,
        keyBase64url,
        status: index === 0 ? 'active' : 'decrypt_only',
      })),
    }),
    TREASURY_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: 'treasury-blind-001',
      keys: blindKeys.map((keyBase64url, index) => ({
        keyId: `treasury-blind-${String(index + 1).padStart(3, '0')}`,
        keyBase64url,
        status: index === 0 ? 'active' : 'lookup_only',
      })),
    }),
  } as AppEnvironment));
}

const context = {
  tenantId: 'tenant-001', resourceType: 'bank_account' as const,
  resourceId: 'account-001', version: 1,
};

describe('TreasuryDataCryptoService', () => {
  it('AES-GCM 往返且 AAD 绑定租户、资源类型、资源标识和版本', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, {
      accountName: '张三', account: '6222000000000001', clearingCode: 'CNAPS001',
    });
    expect(JSON.stringify(protectedData)).not.toContain('6222000000000001');
    expect(crypto.unprotect(context, protectedData)).toEqual({
      accountName: '张三', account: '6222000000000001', clearingCode: 'CNAPS001',
    });
    expect(() => crypto.unprotect({ ...context, tenantId: 'tenant-002' }, protectedData))
      .toThrow('密文或上下文无效');
    expect(() => crypto.unprotect({ ...context, version: 2 }, protectedData))
      .toThrow('密文或上下文无效');
  });

  it('账号盲索引稳定、按租户隔离且轮换期覆盖全部可查询密钥', () => {
    const crypto = service({ blindKeys: [key(), key()] });
    const first = crypto.accountFingerprints('tenant-001', '6222000000000001');
    expect(first).toHaveLength(2);
    expect(first).toEqual(
      crypto.accountFingerprints('tenant-001', '6222000000000001'),
    );
    expect(first).not.toEqual(
      crypto.accountFingerprints('tenant-002', '6222000000000001'),
    );
    expect(JSON.stringify(first)).not.toContain('6222000000000001');
  });

  it('缺失密钥环、非法账号和篡改密文均失败关闭', () => {
    const missing = new TreasuryDataCryptoService(
      new ConfigService<AppEnvironment, true>({} as AppEnvironment),
    );
    expect(() => missing.protect(context, {})).toThrow('密钥环无效');
    expect(() => service().accountFingerprints('tenant-001', 'not-an-account'))
      .toThrow('密文或上下文无效');
    const crypto = service();
    const protectedData = crypto.protect(context, { account: '6222000000000001' });
    expect(() => crypto.unprotect(context, {
      ...protectedData, ciphertext: `${protectedData.ciphertext}A`,
    })).toThrow('密文或上下文无效');
  });

  it('即使 keyId 不同也拒绝数据加密与盲索引复用同一主密钥', () => {
    const shared = key();
    const crypto = service({ encryptionKeys: [shared], blindKeys: [shared] });
    expect(() => crypto.protect(context, {})).toThrow('密钥环无效');
    expect(() => crypto.accountFingerprints('tenant-001', '6222000000000001'))
      .toThrow('密钥环无效');
  });
});
