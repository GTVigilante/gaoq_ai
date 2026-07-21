import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';

function crypto(): ESignWebhookCryptoService {
  return new ESignWebhookCryptoService(new ConfigService<AppEnvironment, true>({
    ESIGN_WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'esign-key-001',
      keys: [{
        keyId: 'esign-key-001', keyBase64url: randomBytes(32).toString('base64url'),
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
});
