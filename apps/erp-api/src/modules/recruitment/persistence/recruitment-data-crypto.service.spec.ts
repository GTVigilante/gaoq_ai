import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import { RecruitmentDataCryptoService } from './recruitment-data-crypto.service.js';

function key(): string {
  return randomBytes(32).toString('base64url');
}

function service(input?: {
  readonly encryptionKeys?: readonly {
    readonly keyId: string;
    readonly keyBase64url: string;
    readonly status: 'active' | 'decrypt_only';
  }[];
  readonly activeEncryptionKeyId?: string;
  readonly blindKeys?: readonly {
    readonly keyId: string;
    readonly keyBase64url: string;
    readonly status: 'active' | 'lookup_only';
  }[];
  readonly activeBlindKeyId?: string;
}): RecruitmentDataCryptoService {
  const encryptionKeys = input?.encryptionKeys ?? [{
    keyId: 'recruitment-key-001', keyBase64url: key(), status: 'active' as const,
  }];
  const blindKeys = input?.blindKeys ?? [{
    keyId: 'blind-key-001', keyBase64url: key(), status: 'active' as const,
  }];
  return new RecruitmentDataCryptoService(new ConfigService<AppEnvironment, true>({
    RECRUITMENT_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: input?.activeEncryptionKeyId ?? 'recruitment-key-001',
      keys: encryptionKeys,
    }),
    RECRUITMENT_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: input?.activeBlindKeyId ?? 'blind-key-001',
      keys: blindKeys,
    }),
  } as AppEnvironment));
}

const context = {
  tenantId: 'tenant-001',
  resourceType: 'candidate_identity' as const,
  resourceId: 'candidate-001',
};

describe('RecruitmentDataCryptoService', () => {
  it('AES-256-GCM 往返且密文不包含候选人明文', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, {
      name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
    });
    expect(JSON.stringify(protectedData)).not.toContain('张三');
    expect(JSON.stringify(protectedData)).not.toContain('13800138000');
    expect(crypto.unprotect(context, protectedData)).toEqual({
      name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
    });
  });

  it('AAD 绑定租户、资源类型和资源标识，篡改任一项均失败关闭', () => {
    const crypto = service();
    const protectedData = crypto.protect(context, { name: '张三' });
    expect(() => crypto.unprotect({ ...context, tenantId: 'tenant-002' }, protectedData))
      .toThrow('密文或上下文无效');
    expect(() => crypto.unprotect({ ...context, resourceId: 'candidate-002' }, protectedData))
      .toThrow('密文或上下文无效');
    expect(() => crypto.unprotect(context, {
      ...protectedData, ciphertext: `${protectedData.ciphertext.slice(0, -1)}A`,
    })).toThrow('密文或上下文无效');
  });

  it('支持 decrypt_only 旧密钥，但新写入只使用 active 密钥', () => {
    const oldKey = key();
    const old = service({
      encryptionKeys: [{ keyId: 'recruitment-key-old', keyBase64url: oldKey, status: 'active' }],
      activeEncryptionKeyId: 'recruitment-key-old',
    });
    const protectedData = old.protect(context, { name: '张三' });
    const rotated = service({
      encryptionKeys: [
        { keyId: 'recruitment-key-old', keyBase64url: oldKey, status: 'decrypt_only' },
        { keyId: 'recruitment-key-new', keyBase64url: key(), status: 'active' },
      ],
      activeEncryptionKeyId: 'recruitment-key-new',
    });
    expect(rotated.unprotect(context, protectedData)).toEqual({ name: '张三' });
    expect(rotated.protect(context, { name: '李四' }).keyId).toBe('recruitment-key-new');
  });

  it('盲索引稳定、租户与字段隔离，并同时生成轮换窗口索引', () => {
    const activeKey = key();
    const lookupKey = key();
    const crypto = service({
      blindKeys: [
        { keyId: 'blind-key-new', keyBase64url: activeKey, status: 'active' },
        { keyId: 'blind-key-old', keyBase64url: lookupKey, status: 'lookup_only' },
      ],
      activeBlindKeyId: 'blind-key-new',
    });
    const first = crypto.blindIndexes('tenant-001', 'phone', '+8613800138000');
    expect(first).toEqual(crypto.blindIndexes('tenant-001', 'phone', '+8613800138000'));
    expect(first).toHaveLength(2);
    expect(first).not.toEqual(crypto.blindIndexes('tenant-002', 'phone', '+8613800138000'));
    expect(first).not.toEqual(crypto.blindIndexes('tenant-001', 'email', '+8613800138000'));
    expect(JSON.stringify(first)).not.toContain('13800138000');
  });

  it('拒绝加密与盲索引复用同一配置字段或不完整密钥环', () => {
    const crypto = new RecruitmentDataCryptoService(new ConfigService<AppEnvironment, true>({
      RECRUITMENT_DATA_ENCRYPTION_KEYS: '',
      RECRUITMENT_BLIND_INDEX_KEYS: '',
    } as AppEnvironment));
    expect(() => crypto.protect(context, { name: '张三' })).toThrow('密钥环无效');
    expect(() => crypto.blindIndexes('tenant-001', 'phone', '+8613800138000'))
      .toThrow('密钥环无效');
  });
});
