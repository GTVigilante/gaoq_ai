import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import type { AppEnvironment } from '../../config/environment.js';

/** 使用独立 Ed25519 密钥签名锚点；禁止复用 OAuth 或审计 HMAC 密钥。 */
@Injectable()
export class AuditAnchorSigner implements OnModuleInit {
  private key: KeyObject | undefined;
  private keyId: string | undefined;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  onModuleInit(): void {
    const encoded = this.config.get('AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64', { infer: true });
    const keyId = this.config.get('AUDIT_ANCHOR_SIGNING_KEY_ID', { infer: true });
    if (encoded === undefined && keyId === undefined) return;
    if (encoded === undefined || keyId === undefined) throw new Error('AUDIT_ANCHOR_KEY_INCOMPLETE');
    try {
      const key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('AUDIT_ANCHOR_KEY_TYPE_INVALID');
      this.key = key;
      this.keyId = keyId;
    } catch (error) {
      if (error instanceof Error && error.message === 'AUDIT_ANCHOR_KEY_TYPE_INVALID') throw error;
      throw new Error('AUDIT_ANCHOR_KEY_INVALID', { cause: error });
    }
  }

  sign(payloadCanonical: string): { readonly keyId: string; readonly signature: string } {
    if (this.key === undefined || this.keyId === undefined) {
      throw new Error('AUDIT_ANCHOR_SIGNING_DISABLED');
    }
    return Object.freeze({
      keyId: this.keyId,
      signature: sign(null, Buffer.from(payloadCanonical, 'utf8'), this.key).toString('base64url'),
    });
  }
}
