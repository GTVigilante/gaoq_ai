import {
  createCipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OP_MAX_APPROVAL_BODY_BYTES } from './op-approval.contract.js';
import { OpApprovalWebhookCryptoService } from './op-approval-webhook-crypto.service.js';
import { OP_MAX_WEBHOOK_BODY_BYTES } from './op-operating-summary.contract.js';
import {
  type ProtectedOpWebhook,
  OpWebhookCryptoService,
} from './op-webhook-crypto.service.js';

const TENANT_ID = 'tenant-001';
const INBOX_ID = '01K00000000000000000000000';

interface CryptoCase {
  readonly name: string;
  readonly configKey: keyof AppEnvironment;
  readonly prefix: 'OP_WEBHOOK' | 'OP_APPROVAL';
  readonly salt: string;
  readonly aadPrefix: string;
  readonly maximumBytes: number;
  readonly create: (config: ConfigService<AppEnvironment, true>) => {
    protect(tenantId: string, inboxId: string, body: Buffer): ProtectedOpWebhook;
    unprotect(tenantId: string, inboxId: string, payload: ProtectedOpWebhook): Buffer;
  };
}

const cases: readonly CryptoCase[] = [
  {
    name: '经营摘要',
    configKey: 'OP_WEBHOOK_ENCRYPTION_KEYS',
    prefix: 'OP_WEBHOOK',
    salt: 'gaoq-op-webhook-v1',
    aadPrefix: 'op-webhook',
    maximumBytes: OP_MAX_WEBHOOK_BODY_BYTES,
    create: (config) => new OpWebhookCryptoService(config),
  },
  {
    name: '审批请求',
    configKey: 'OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS',
    prefix: 'OP_APPROVAL',
    salt: 'gaoq-op-approval-webhook-v1',
    aadPrefix: 'op-approval-webhook',
    maximumBytes: OP_MAX_APPROVAL_BODY_BYTES,
    create: (config) => new OpApprovalWebhookCryptoService(config),
  },
];

function ring(
  activeKey: Buffer = randomBytes(32),
  extraKeys: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify({
    activeKeyId: 'key-active',
    keys: [
      {
        keyId: 'key-active',
        keyBase64url: activeKey.toString('base64url'),
        status: 'active',
      },
      ...extraKeys,
    ],
  });
}

function createService(item: CryptoCase, raw: string | undefined) {
  const values = raw === undefined ? {} : { [item.configKey]: raw };
  return item.create(new ConfigService<AppEnvironment, true>(
    values,
  ));
}

function encryptedOneByte(item: CryptoCase, master: Buffer): ProtectedOpWebhook {
  const key = Buffer.from(hkdfSync(
    'sha256',
    master,
    Buffer.from(item.salt, 'utf8'),
    Buffer.from('payload-encryption', 'utf8'),
    32,
  ));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${item.aadPrefix}\0${TENANT_ID}\0${INBOX_ID}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from('x')), cipher.final()]);
  key.fill(0);
  return {
    payloadKeyId: 'key-active',
    payloadIv: iv.toString('base64url'),
    payloadCiphertext: ciphertext.toString('base64url'),
    payloadAuthTag: cipher.getAuthTag().toString('base64url'),
  };
}

describe.each(cases)('$name OP Webhook 加密边界', (item) => {
  it('使用独立密钥域和 AAD 往返原始字节', () => {
    const service = createService(item, ring());
    const body = Buffer.from('{"safe":true}', 'utf8');
    const protectedPayload = service.protect(TENANT_ID, INBOX_ID, body);

    expect(Object.isFrozen(protectedPayload)).toBe(true);
    expect(JSON.stringify(protectedPayload)).not.toContain(body.toString('utf8'));
    expect(service.unprotect(TENANT_ID, INBOX_ID, protectedPayload)).toEqual(body);
    expect(() => service.unprotect('tenant-002', INBOX_ID, protectedPayload))
      .toThrow(`${item.prefix}_PAYLOAD_INVALID`);
    expect(() => service.unprotect(TENANT_ID, `${INBOX_ID}X`, protectedPayload))
      .toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it('轮换后仅解密密钥仍可读取旧载荷', () => {
    const oldKey = randomBytes(32);
    const protectedPayload = createService(item, ring(oldKey))
      .protect(TENANT_ID, INBOX_ID, Buffer.from('{"version":1}', 'utf8'));
    const nextKey = randomBytes(32);
    const rotated = JSON.stringify({
      activeKeyId: 'key-next',
      keys: [
        {
          keyId: 'key-active',
          keyBase64url: oldKey.toString('base64url'),
          status: 'decrypt_only',
        },
        {
          keyId: 'key-next',
          keyBase64url: nextKey.toString('base64url'),
          status: 'active',
        },
      ],
    });

    expect(createService(item, rotated).unprotect(
      TENANT_ID,
      INBOX_ID,
      protectedPayload,
    )).toEqual(Buffer.from('{"version":1}', 'utf8'));
  });

  it.each([
    ['', INBOX_ID, Buffer.from('{}')],
    ['tenant/invalid', INBOX_ID, Buffer.from('{}')],
    [TENANT_ID, '', Buffer.from('{}')],
    [TENANT_ID, 'inbox invalid', Buffer.from('{}')],
    [TENANT_ID, INBOX_ID, Buffer.alloc(0)],
    [TENANT_ID, INBOX_ID, Buffer.from('x')],
  ])('拒绝非法加密输入 %#', (tenantId, inboxId, body) => {
    expect(() => createService(item, ring()).protect(tenantId, inboxId, body))
      .toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it('拒绝超过正文上限的加密输入', () => {
    expect(() => createService(item, ring()).protect(
      TENANT_ID,
      INBOX_ID,
      Buffer.alloc(item.maximumBytes + 1),
    )).toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it.each([
    { field: 'tenant', value: '' },
    { field: 'inbox', value: '' },
    { field: 'payloadKeyId', value: 'bad key' },
    { field: 'payloadIv', value: '*' },
    { field: 'payloadIv', value: Buffer.alloc(11).toString('base64url') },
    { field: 'payloadCiphertext', value: '*' },
    { field: 'payloadAuthTag', value: '*' },
    { field: 'payloadAuthTag', value: Buffer.alloc(15).toString('base64url') },
  ])('拒绝非法密文结构 $field', ({ field, value }) => {
    const service = createService(item, ring());
    const payload = service.protect(TENANT_ID, INBOX_ID, Buffer.from('{}'));
    const tenantId = field === 'tenant' ? value : TENANT_ID;
    const inboxId = field === 'inbox' ? value : INBOX_ID;
    const changed = field.startsWith('payload') ? { ...payload, [field]: value } : payload;

    expect(() => service.unprotect(tenantId, inboxId, changed))
      .toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it('拒绝超大密文、未知密钥和认证标签篡改', () => {
    const service = createService(item, ring());
    const payload = service.protect(TENANT_ID, INBOX_ID, Buffer.from('{}'));

    expect(() => service.unprotect(TENANT_ID, INBOX_ID, {
      ...payload,
      payloadCiphertext: Buffer.alloc(item.maximumBytes + 1).toString('base64url'),
    })).toThrow(`${item.prefix}_PAYLOAD_INVALID`);
    expect(() => service.unprotect(TENANT_ID, INBOX_ID, {
      ...payload,
      payloadKeyId: 'key-missing',
    })).toThrow(`${item.prefix}_KEY_UNAVAILABLE`);
    expect(() => service.unprotect(TENANT_ID, INBOX_ID, {
      ...payload,
      payloadAuthTag: randomBytes(16).toString('base64url'),
    })).toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it('拒绝解密后不足两个字节的受损载荷', () => {
    const master = randomBytes(32);
    const service = createService(item, ring(master));
    expect(() => service.unprotect(
      TENANT_ID,
      INBOX_ID,
      encryptedOneByte(item, master),
    )).toThrow(`${item.prefix}_PAYLOAD_INVALID`);
  });

  it.each([
    undefined,
    '{',
    JSON.stringify({ activeKeyId: 'key-active', keys: [] }),
    JSON.stringify({
      activeKeyId: 'key-missing',
      keys: [{
        keyId: 'key-active',
        keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
    JSON.stringify({
      activeKeyId: 'key-active',
      keys: [
        {
          keyId: 'key-active',
          keyBase64url: randomBytes(32).toString('base64url'),
          status: 'active',
        },
        {
          keyId: 'key-active',
          keyBase64url: randomBytes(32).toString('base64url'),
          status: 'decrypt_only',
        },
      ],
    }),
    JSON.stringify({
      activeKeyId: 'key-active',
      keys: [{
        keyId: 'key-active',
        keyBase64url: 'short',
        status: 'active',
      }],
    }),
  ])('密钥环缺失或受损时失败关闭 %#', (raw) => {
    try {
      createService(item, raw).protect(TENANT_ID, INBOX_ID, Buffer.from('{}'));
      expect.unreachable('受损密钥环必须失败关闭');
    } catch (error) {
      expect(error).toMatchObject({
        response: { code: `${item.prefix}_KEYRING_UNAVAILABLE` },
      });
    }
  });
});
