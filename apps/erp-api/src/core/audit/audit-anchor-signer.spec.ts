import type { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { AuditAnchorSigner } from './audit-anchor-signer.js';

describe('AuditAnchorSigner', () => {
  it('使用独立 Ed25519 PKCS#8 密钥生成可验证签名', () => {
    const pair = generateKeyPairSync('ed25519');
    const encoded = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const values: Readonly<Record<string, string>> = {
      AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64: encoded,
      AUDIT_ANCHOR_SIGNING_KEY_ID: 'anchor-key-001',
    };
    const config = { get: (key: string) => values[key] } as unknown as
      ConfigService<AppEnvironment, true>;
    const signer = new AuditAnchorSigner(config);
    signer.onModuleInit();
    const signed = signer.sign('{"sequence":1}');
    expect(signed.keyId).toBe('anchor-key-001');
    expect(verify(
      null,
      Buffer.from('{"sequence":1}'),
      pair.publicKey,
      Buffer.from(signed.signature, 'base64url'),
    )).toBe(true);
  });

  it('拒绝非 Ed25519 密钥且未配置时失败关闭', () => {
    const disabled = new AuditAnchorSigner({
      get: () => undefined,
    } as unknown as ConfigService<AppEnvironment, true>);
    disabled.onModuleInit();
    expect(() => disabled.sign('{}')).toThrow('AUDIT_ANCHOR_SIGNING_DISABLED');

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const invalid = new AuditAnchorSigner({
      get: (key: string) => key.endsWith('BASE64')
        ? pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
        : 'anchor-key-001',
    } as unknown as ConfigService<AppEnvironment, true>);
    expect(() => invalid.onModuleInit()).toThrow('AUDIT_ANCHOR_KEY_TYPE_INVALID');
  });
});
