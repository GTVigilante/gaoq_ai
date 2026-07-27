import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  type ProtectedTreasuryData,
  TreasuryDataCryptoError,
  TreasuryDataCryptoService,
} from './treasury-data-crypto.service.js';

function key(): string { return randomBytes(32).toString('base64url'); }

function encryptionKey(
  keyId: string,
  status: 'active' | 'decrypt_only',
  keyBase64url = key(),
) {
  return { keyId, keyBase64url, status };
}

function blindKey(
  keyId: string,
  status: 'active' | 'lookup_only',
  keyBase64url = key(),
) {
  return { keyId, keyBase64url, status };
}

function fromRaw(
  encryptionRaw: string | undefined,
  blindRaw: string | undefined,
): TreasuryDataCryptoService {
  return new TreasuryDataCryptoService(new ConfigService<AppEnvironment, true>({
    TREASURY_DATA_ENCRYPTION_KEYS: encryptionRaw,
    TREASURY_BLIND_INDEX_KEYS: blindRaw,
  } as AppEnvironment));
}

function fromRings(encryption: unknown, blindIndex: unknown): TreasuryDataCryptoService {
  return fromRaw(JSON.stringify(encryption), JSON.stringify(blindIndex));
}

function defaultEncryptionRing(material = key()) {
  return {
    activeKeyId: 'treasury-key-001',
    keys: [encryptionKey('treasury-key-001', 'active', material)],
  };
}

function defaultBlindRing(material = key()) {
  return {
    activeKeyId: 'treasury-blind-001',
    keys: [blindKey('treasury-blind-001', 'active', material)],
  };
}

function service(input?: {
  readonly encryptionKeys?: readonly string[];
  readonly blindKeys?: readonly string[];
}): TreasuryDataCryptoService {
  const encryptionKeys = input?.encryptionKeys ?? [key()];
  const blindKeys = input?.blindKeys ?? [key()];
  return fromRings({
      activeKeyId: 'treasury-key-001',
      keys: encryptionKeys.map((keyBase64url, index) => ({
        keyId: `treasury-key-${String(index + 1).padStart(3, '0')}`,
        keyBase64url,
        status: index === 0 ? 'active' : 'decrypt_only',
      })),
    }, {
      activeKeyId: 'treasury-blind-001',
      keys: blindKeys.map((keyBase64url, index) => ({
        keyId: `treasury-blind-${String(index + 1).padStart(3, '0')}`,
        keyBase64url,
        status: index === 0 ? 'active' : 'lookup_only',
      })),
    });
}

const context = {
  tenantId: 'tenant-001', resourceType: 'bank_account' as const,
  resourceId: 'account-001', version: 1,
};

function expectTreasuryError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TreasuryDataCryptoError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`预期资金密文操作失败：${code}`);
}

describe('TreasuryDataCryptoService', () => {
  it('AES-GCM 往返且 AAD 绑定租户、资源类型、资源标识和版本', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, {
      accountName: '张三', account: '6222000000000001', clearingCode: 'CNAPS001',
    });
    expect(JSON.stringify(protectedData)).not.toContain('6222000000000001');
    expect(Object.isFrozen(protectedData)).toBe(true);
    expect(Buffer.from(protectedData.iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(protectedData.authTag, 'base64url')).toHaveLength(16);
    expect(crypto.unprotect(context, protectedData)).toEqual({
      accountName: '张三', account: '6222000000000001', clearingCode: 'CNAPS001',
    });
    for (const changed of [
      { ...context, tenantId: 'tenant-002' },
      { ...context, resourceType: 'bank_return' as const },
      { ...context, resourceId: 'account-002' },
      { ...context, version: 2 },
    ]) {
      expectTreasuryError(
        () => crypto.unprotect(changed, protectedData),
        'TREASURY_DATA_CIPHERTEXT_INVALID',
      );
    }
  });

  it('上下文的租户、资源、版本与资源类型均严格失败关闭', () => {
    const crypto = service();
    for (const invalid of [
      { ...context, tenantId: 'bad/tenant' },
      { ...context, resourceId: '' },
      { ...context, version: 0 },
      { ...context, version: 1.5 },
      { ...context, resourceType: 'tax_filing' },
    ]) {
      expectTreasuryError(
        () => crypto.protect(invalid as typeof context, {}),
        'TREASURY_DATA_CIPHERTEXT_INVALID',
      );
    }
    expectTreasuryError(
      () => crypto.accountFingerprints('bad/tenant', '6222000000000001'),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
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
    expectTreasuryError(
      () => missing.protect(context, {}),
      'TREASURY_DATA_KEY_RING_INVALID',
    );
    expectTreasuryError(
      () => service().accountFingerprints('tenant-001', 'not-an-account'),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
    const crypto = service();
    const protectedData = crypto.protect(context, { account: '6222000000000001' });
    expectTreasuryError(
      () => crypto.unprotect(context, {
        ...protectedData,
        ciphertext: `${protectedData.ciphertext}A`,
      }),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
  });

  it('两个密钥环的缺失、非法 JSON、重复标识和活动状态冲突均失败关闭', () => {
    const secret = key();
    const invalidEncryption = [
      undefined,
      '',
      '{not-json',
      JSON.stringify({ activeKeyId: 'key-1', keys: [] }),
      JSON.stringify({
        activeKeyId: 'key-1',
        keys: [
          encryptionKey('key-1', 'active', secret),
          encryptionKey('key-1', 'decrypt_only', secret),
        ],
      }),
      JSON.stringify({
        activeKeyId: 'key-1',
        keys: [encryptionKey('key-1', 'active'), encryptionKey('key-2', 'active')],
      }),
      JSON.stringify({
        activeKeyId: 'key-2',
        keys: [
          encryptionKey('key-1', 'active'),
          encryptionKey('key-2', 'decrypt_only'),
        ],
      }),
    ];
    const validBlind = JSON.stringify(defaultBlindRing());
    for (const raw of invalidEncryption) {
      expectTreasuryError(
        () => fromRaw(raw, validBlind).protect(context, {}),
        'TREASURY_DATA_KEY_RING_INVALID',
      );
    }

    const validEncryption = JSON.stringify(defaultEncryptionRing());
    const invalidBlind = JSON.stringify({
      activeKeyId: 'blind-2',
      keys: [blindKey('blind-1', 'active'), blindKey('blind-2', 'lookup_only')],
    });
    expectTreasuryError(
      () => fromRaw(validEncryption, invalidBlind)
        .accountFingerprints('tenant-001', '6222000000000001'),
      'TREASURY_DATA_KEY_RING_INVALID',
    );
  });

  it('非规范主密钥稳定归类为密钥环错误', () => {
    const noncanonical = `${'A'.repeat(42)}B`;
    const crypto = fromRings({
      activeKeyId: 'key-1',
      keys: [encryptionKey('key-1', 'active', noncanonical)],
    }, defaultBlindRing());
    expectTreasuryError(
      () => crypto.protect(context, {}),
      'TREASURY_DATA_KEY_RING_INVALID',
    );
  });

  it('加密密钥轮换只写活动密钥并允许 decrypt_only 历史密钥解密', () => {
    const oldSecret = key();
    const newSecret = key();
    const blindRing = defaultBlindRing();
    const oldCrypto = fromRings({
      activeKeyId: 'key-old',
      keys: [encryptionKey('key-old', 'active', oldSecret)],
    }, blindRing);
    const oldProtected = oldCrypto.protect(context, { amount: 100 });
    const rotated = fromRings({
      activeKeyId: 'key-new',
      keys: [
        encryptionKey('key-new', 'active', newSecret),
        encryptionKey('key-old', 'decrypt_only', oldSecret),
      ],
    }, blindRing);
    expect(rotated.unprotect(context, oldProtected)).toEqual({ amount: 100 });
    expect(rotated.protect(context, { amount: 200 }).keyId).toBe('key-new');
    const withoutOld = fromRings({
      activeKeyId: 'key-new',
      keys: [encryptionKey('key-new', 'active', newSecret)],
    }, blindRing);
    expectTreasuryError(
      () => withoutOld.unprotect(context, oldProtected),
      'TREASURY_DATA_KEY_UNAVAILABLE',
    );
  });

  it('密文元数据、规范编码、固定长度和认证标签任一异常均拒绝解密', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, { amount: 100 });
    const invalid: readonly Partial<ProtectedTreasuryData>[] = [
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
      expectTreasuryError(
        () => crypto.unprotect(context, candidate as ProtectedTreasuryData),
        'TREASURY_DATA_CIPHERTEXT_INVALID',
      );
    }
    for (const candidate of [null, undefined, 'ciphertext']) {
      expectTreasuryError(
        () => crypto.unprotect(context, candidate as never),
        'TREASURY_DATA_CIPHERTEXT_INVALID',
      );
    }
  });

  it('不可序列化明文和超出八 MiB 的输入均映射为稳定错误', () => {
    const crypto = service();
    expectTreasuryError(
      () => crypto.protect(context, { amount: 1n }),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
    expectTreasuryError(
      () => crypto.protect(context, 'x'.repeat(8 * 1024 * 1024)),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
    const protectedData = crypto.protect(context, { amount: 100 });
    expectTreasuryError(
      () => crypto.unprotect(context, {
        ...protectedData,
        ciphertext: 'A'.repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3) + 1),
      }),
      'TREASURY_DATA_CIPHERTEXT_INVALID',
    );
  });

  it('即使 keyId 不同也拒绝数据加密与盲索引复用同一主密钥', () => {
    const shared = key();
    const crypto = service({ encryptionKeys: [shared], blindKeys: [shared] });
    expectTreasuryError(
      () => crypto.protect(context, {}),
      'TREASURY_DATA_KEY_RING_INVALID',
    );
    expectTreasuryError(
      () => crypto.accountFingerprints('tenant-001', '6222000000000001'),
      'TREASURY_DATA_KEY_RING_INVALID',
    );
  });
});
