import { ConfigService } from '@nestjs/config';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { ApprovalDataCryptoService } from './approval-data-crypto.service.js';

const KEY = randomBytes(32).toString('base64url');
const CONTEXT = {
  tenantId: 'tenant-001',
  instanceId: 'instance-001',
  definitionHash: 'a'.repeat(43),
};

interface TestKey {
  readonly keyId: string;
  readonly keyBase64url: string;
  readonly status: 'active' | 'decrypt_only';
}

function service(
  keys: readonly TestKey[] = [{
    keyId: 'approval-key-001', keyBase64url: KEY, status: 'active',
  }],
  activeKeyId = 'approval-key-001',
): ApprovalDataCryptoService {
  const config = new ConfigService<AppEnvironment, true>({
    APPROVAL_DATA_ENCRYPTION_KEYS: JSON.stringify({ activeKeyId, keys }),
  } as AppEnvironment);
  return new ApprovalDataCryptoService(config);
}

function serviceFromRaw(raw: string | undefined): ApprovalDataCryptoService {
  const config = new ConfigService<AppEnvironment, true>({
    APPROVAL_DATA_ENCRYPTION_KEYS: raw,
  } as AppEnvironment);
  return new ApprovalDataCryptoService(config);
}

describe('ApprovalDataCryptoService', () => {
  it('加密后不保留明文且可在同一 AAD 上解密', () => {
    const crypto = service();
    const protectedData = crypto.protect(CONTEXT, { amount: 123_45, remark: '客户现场' });
    expect(JSON.stringify(protectedData)).not.toContain('客户现场');
    expect(crypto.unprotect(CONTEXT, protectedData)).toEqual({ amount: 123_45, remark: '客户现场' });
  });

  it('租户、实例或模板摘要变化时认证失败', () => {
    const crypto = service();
    const protectedData = crypto.protect(CONTEXT, { amount: 123_45 });
    expect(() => crypto.unprotect({ ...CONTEXT, tenantId: 'tenant-002' }, protectedData)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_DATA_CIPHERTEXT_INVALID' }),
    );
  });

  it('密文或认证标签篡改时失败关闭', () => {
    const crypto = service();
    const protectedData = crypto.protect(CONTEXT, { amount: 123_45 });
    expect(() => crypto.unprotect(CONTEXT, {
      ...protectedData,
      formDataAuthTag: `${protectedData.formDataAuthTag[0] === 'A' ? 'B' : 'A'}${
        protectedData.formDataAuthTag.slice(1)
      }`,
    })).toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_CIPHERTEXT_INVALID' }));
  });

  it('支持 decrypt_only 旧密钥但拒绝未知 keyId', () => {
    const oldKey = randomBytes(32).toString('base64url');
    const oldCrypto = service([{ keyId: 'approval-key-001', keyBase64url: oldKey, status: 'active' }]);
    const protectedData = oldCrypto.protect(CONTEXT, { amount: 1 });
    const rotated = service([
      { keyId: 'approval-key-001', keyBase64url: oldKey, status: 'decrypt_only' },
      { keyId: 'approval-key-002', keyBase64url: KEY, status: 'active' },
    ], 'approval-key-002');
    expect(rotated.unprotect(CONTEXT, protectedData)).toEqual({ amount: 1 });
    expect(() => rotated.unprotect(CONTEXT, { ...protectedData, formDataKeyId: 'missing-key' }))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_KEY_UNAVAILABLE' }));
  });

  it.each([
    undefined,
    '{invalid-json',
    JSON.stringify({
      activeKeyId: 'approval-key-001',
      keys: [
        { keyId: 'approval-key-001', keyBase64url: KEY, status: 'active' },
        { keyId: 'approval-key-001', keyBase64url: KEY, status: 'decrypt_only' },
      ],
    }),
    JSON.stringify({
      activeKeyId: 'approval-key-002',
      keys: [{ keyId: 'approval-key-001', keyBase64url: KEY, status: 'active' }],
    }),
    JSON.stringify({
      activeKeyId: 'approval-key-001',
      keys: [
        { keyId: 'approval-key-001', keyBase64url: KEY, status: 'active' },
        { keyId: 'approval-key-002', keyBase64url: KEY, status: 'active' },
      ],
    }),
    JSON.stringify({
      activeKeyId: 'approval-key-001',
      keys: [{
        keyId: 'approval-key-001',
        keyBase64url: `${'A'.repeat(42)}B`,
        status: 'active',
      }],
    }),
  ])('拒绝缺失、损坏、重复或活动状态不一致的密钥环 %#', (raw) => {
    expect(() => serviceFromRaw(raw).protect(CONTEXT, { amount: 1 }))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_KEY_RING_INVALID' }));
  });

  it.each([
    { formDataKeyId: '非法 空格' },
    { formDataIv: '*' },
    { formDataCiphertext: '*' },
    { formDataAuthTag: '*' },
    { formDataIv: 'a' },
    { formDataAuthTag: 'a' },
  ])('拒绝格式或编码长度非法的密文载荷 %#', (patch) => {
    const crypto = service();
    const protectedData = crypto.protect(CONTEXT, { amount: 1 });
    expect(() => crypto.unprotect(CONTEXT, { ...protectedData, ...patch }))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_CIPHERTEXT_INVALID' }));
  });

  it.each([
    { tenantId: '非法 空格' },
    { instanceId: '非法 空格' },
    { definitionHash: 'invalid' },
  ])('拒绝未绑定可信租户、实例或模板摘要的上下文 %#', (patch) => {
    const crypto = service();
    expect(() => crypto.protect({ ...CONTEXT, ...patch }, { amount: 1 }))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_CIPHERTEXT_INVALID' }));
  });

  it('认证通过但明文不是 JSON 时仍失败关闭', () => {
    const masterKey = Buffer.from(KEY, 'base64url');
    const encryptionKey = Buffer.from(hkdfSync(
      'sha256',
      masterKey,
      Buffer.from('gaoq-approval-data-v1', 'utf8'),
      Buffer.from('form-data-encryption-v1', 'utf8'),
      32,
    ));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify([
      'gaoq-approval-data-v1',
      CONTEXT.tenantId,
      CONTEXT.instanceId,
      CONTEXT.definitionHash,
    ]), 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from('not-json', 'utf8')),
      cipher.final(),
    ]);
    const protectedData = {
      formDataKeyId: 'approval-key-001',
      formDataIv: iv.toString('base64url'),
      formDataCiphertext: ciphertext.toString('base64url'),
      formDataAuthTag: cipher.getAuthTag().toString('base64url'),
    };
    expect(() => service().unprotect(CONTEXT, protectedData))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DATA_CIPHERTEXT_INVALID' }));
    masterKey.fill(0);
    encryptionKey.fill(0);
  });
});
