import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';

const KEY_ONE = randomBytes(32).toString('base64url');
const KEY_TWO = randomBytes(32).toString('base64url');

interface CryptoInternals {
  encrypt(
    plaintext: Buffer,
    aad: Buffer,
    purpose: string,
  ): {
    readonly keyId: string;
    readonly iv: string;
    readonly ciphertext: string;
    readonly authTag: string;
  };
  decrypt(
    payload: {
      readonly keyId: string;
      readonly iv: string;
      readonly ciphertext: string;
      readonly authTag: string;
    },
    aad: Buffer,
    purpose: string,
    maxBytes: number,
  ): Buffer;
}

function crypto(rawRing?: unknown): ESignWebhookCryptoService {
  return new ESignWebhookCryptoService(new ConfigService<AppEnvironment, true>({
    ESIGN_WEBHOOK_ENCRYPTION_KEYS: JSON.stringify(rawRing ?? {
      activeKeyId: 'esign-key-001',
      keys: [{
        keyId: 'esign-key-001', keyBase64url: KEY_ONE,
        status: 'active',
      }],
    }),
  } as AppEnvironment));
}

describe('ESignWebhookCryptoService', () => {
  it('原始回调字节使用租户与 Inbox AAD 整体加密', () => {
    const service = crypto();
    const raw = Buffer.from('{"action":"SIGN_FLOW_COMPLETE","signFlowTitle":"劳动合同"}');
    const protectedPayload = service.protect('tenant-001', 'inbox-001', raw);
    expect(JSON.stringify(protectedPayload)).not.toContain('劳动合同');
    expect(service.unprotect('tenant-001', 'inbox-001', protectedPayload).equals(raw)).toBe(true);
    expect(() => service.unprotect('tenant-002', 'inbox-001', protectedPayload))
      .toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('密文篡改和无效密钥环失败关闭', () => {
    const service = crypto();
    const protectedPayload = service.protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}'));
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      ...protectedPayload,
      payloadAuthTag: `${protectedPayload.payloadAuthTag[0] === 'A' ? 'B' : 'A'}${
        protectedPayload.payloadAuthTag.slice(1)
      }`,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    const invalid = new ESignWebhookCryptoService(new ConfigService<AppEnvironment, true>({
      ESIGN_WEBHOOK_ENCRYPTION_KEYS: 'not-json',
    } as AppEnvironment));
    expect(() => invalid.protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}')))
      .toThrow('ESIGN_WEBHOOK_KEY_RING_INVALID');
  });

  it('外部流程标识使用独立 AAD 与派生用途加密', () => {
    const service = crypto();
    const protectedId = service.protectExternalId(
      'tenant-001', '01K00000000000000000000000', 'esign-flow-sensitive-001',
    );
    expect(JSON.stringify(protectedId)).not.toContain('esign-flow-sensitive-001');
    expect(service.unprotectExternalId(
      'tenant-001', '01K00000000000000000000000', protectedId,
    )).toBe('esign-flow-sensitive-001');
    expect(() => service.unprotectExternalId(
      'tenant-001', '01K00000000000000000000001', protectedId,
    )).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('轮换后 decrypt_only 旧密钥仍可解密，但新数据只使用 active 密钥', () => {
    const old = crypto();
    const protectedPayload = old.protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}'));
    const rotated = crypto({
      activeKeyId: 'esign-key-002',
      keys: [
        { keyId: 'esign-key-001', keyBase64url: KEY_ONE, status: 'decrypt_only' },
        { keyId: 'esign-key-002', keyBase64url: KEY_TWO, status: 'active' },
      ],
    });
    expect(rotated.unprotect('tenant-001', 'inbox-001', protectedPayload).toString())
      .toBe('{"a":1}');
    expect(rotated.protect('tenant-001', 'inbox-002', Buffer.from('{"b":2}')).payloadKeyId)
      .toBe('esign-key-002');
  });

  it.each([
    [{ activeKeyId: 'esign-key-001', keys: [
      { keyId: 'esign-key-001', keyBase64url: KEY_ONE, status: 'active' },
      { keyId: 'esign-key-001', keyBase64url: KEY_TWO, status: 'decrypt_only' },
    ] }],
    [{ activeKeyId: 'esign-key-001', keys: [
      { keyId: 'esign-key-001', keyBase64url: KEY_ONE, status: 'active' },
      { keyId: 'esign-key-002', keyBase64url: KEY_TWO, status: 'active' },
    ] }],
    [{ activeKeyId: 'esign-key-002', keys: [
      { keyId: 'esign-key-001', keyBase64url: KEY_ONE, status: 'active' },
    ] }],
    [{ activeKeyId: 'esign-key-001', keys: [
      { keyId: 'esign-key-001', keyBase64url: `${KEY_ONE.slice(0, -1)}B`, status: 'active' },
    ] }],
  ])('密钥环结构失败关闭：%s', (ring) => {
    expect(() => crypto(ring).protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}')))
      .toThrow('ESIGN_WEBHOOK_KEY_RING_INVALID');
  });

  it('未知 keyId 与非规范 base64url 在解码前失败关闭', () => {
    const service = crypto();
    const payload = service.protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}'));
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      ...payload,
      payloadKeyId: 'esign-key-unknown',
    })).toThrow('ESIGN_WEBHOOK_KEY_UNAVAILABLE');
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      ...payload,
      payloadIv: '_x',
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      ...payload,
      payloadCiphertext: `${'A'.repeat(Math.ceil(1024 * 1024 * 4 / 3))}A`,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('正文、标识和 AAD 上下文的长度边界失败关闭', () => {
    const service = crypto();
    expect(() => service.protect('tenant-001', 'inbox-001', Buffer.alloc(1)))
      .toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    expect(() => service.protect(
      'tenant-001', 'inbox-001', Buffer.alloc(1024 * 1024 + 1),
    )).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    expect(() => service.protect('bad tenant', 'inbox-001', Buffer.from('{}')))
      .toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    expect(() => service.protectExternalId('tenant-001', 'flow-001', ''))
      .toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
    expect(() => service.protectExternalId('tenant-001', 'flow-001', 'x'.repeat(513)))
      .toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('外部标识密文同样拒绝未知密钥和非规范字段', () => {
    const service = crypto();
    const payload = service.protectExternalId('tenant-001', 'flow-001', 'external-flow-001');
    expect(() => service.unprotectExternalId('tenant-001', 'flow-001', {
      ...payload,
      externalIdKeyId: 'esign-key-unknown',
    })).toThrow('ESIGN_WEBHOOK_KEY_UNAVAILABLE');
    expect(() => service.unprotectExternalId('tenant-001', 'flow-001', {
      ...payload,
      externalIdAuthTag: '_x',
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it.each([
    [{ payloadKeyId: 'bad key' }],
    [{ payloadIv: '*' }],
    [{ payloadCiphertext: '*' }],
    [{ payloadAuthTag: '*' }],
    [{ payloadIv: 'AA' }],
    [{ payloadAuthTag: 'AA' }],
  ])('Webhook 密文字段逐项失败关闭：%s', (override) => {
    const service = crypto();
    const payload = service.protect('tenant-001', 'inbox-001', Buffer.from('{"a":1}'));
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      ...payload,
      ...override,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it.each([
    [{ externalIdKeyId: 'bad key' }],
    [{ externalIdIv: '*' }],
    [{ externalIdCiphertext: '*' }],
    [{ externalIdAuthTag: '*' }],
    [{ externalIdIv: 'AA' }],
    [{ externalIdAuthTag: 'AA' }],
  ])('外部标识密文字段逐项失败关闭：%s', (override) => {
    const service = crypto();
    const payload = service.protectExternalId('tenant-001', 'flow-001', 'external-flow-001');
    expect(() => service.unprotectExternalId('tenant-001', 'flow-001', {
      ...payload,
      ...override,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('解密后仍校验正文最小长度与外部标识 UTF-8 规范性', () => {
    const service = crypto();
    const internal = service as unknown as CryptoInternals;
    const webhookAad = Buffer.from(JSON.stringify([
      'gaoq-esign-webhook-v1', 'tenant-001', 'inbox-001',
    ]));
    const oneByte = internal.encrypt(
      Buffer.from('x'), webhookAad, 'payload-encryption-v1',
    );
    expect(() => service.unprotect('tenant-001', 'inbox-001', {
      payloadKeyId: oneByte.keyId,
      payloadIv: oneByte.iv,
      payloadCiphertext: oneByte.ciphertext,
      payloadAuthTag: oneByte.authTag,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');

    const identifierAad = Buffer.from(JSON.stringify([
      'gaoq-esign-external-id-v1', 'tenant-001', 'flow-001',
    ]));
    const invalidUtf8 = internal.encrypt(
      Buffer.from([0xff]), identifierAad, 'external-id-encryption-v1',
    );
    expect(() => service.unprotectExternalId('tenant-001', 'flow-001', {
      externalIdKeyId: invalidUtf8.keyId,
      externalIdIv: invalidUtf8.iv,
      externalIdCiphertext: invalidUtf8.ciphertext,
      externalIdAuthTag: invalidUtf8.authTag,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');

    const empty = internal.encrypt(
      Buffer.alloc(0), identifierAad, 'external-id-encryption-v1',
    );
    expect(() => service.unprotectExternalId('tenant-001', 'flow-001', {
      externalIdKeyId: empty.keyId,
      externalIdIv: empty.iv,
      externalIdCiphertext: empty.ciphertext,
      externalIdAuthTag: empty.authTag,
    })).toThrow('ESIGN_WEBHOOK_PAYLOAD_INVALID');
  });

  it('内部解密通道也按调用方上限计算密文编码边界', () => {
    const service = crypto();
    const internal = service as unknown as CryptoInternals;
    const aad = Buffer.from('test-aad');
    const payload = internal.encrypt(Buffer.from('abc'), aad, 'test-purpose');
    expect(internal.decrypt(payload, aad, 'test-purpose', 3)).toEqual(Buffer.from('abc'));
  });

  it('缺失密钥环配置失败关闭', () => {
    const service = new ESignWebhookCryptoService(new ConfigService<AppEnvironment, true>(
      {} as AppEnvironment,
    ));
    expect(() => service.protect('tenant-001', 'inbox-001', Buffer.from('{}')))
      .toThrow('ESIGN_WEBHOOK_KEY_RING_INVALID');
  });
});
