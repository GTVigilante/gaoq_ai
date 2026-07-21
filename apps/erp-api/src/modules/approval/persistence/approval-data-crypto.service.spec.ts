import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
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
});
