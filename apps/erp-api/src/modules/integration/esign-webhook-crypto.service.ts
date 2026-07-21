import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyRingSchema = z.object({
  activeKeyId: z.string().regex(ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(ID_PATTERN),
    keyBase64url: z.string().regex(KEY_PATTERN),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: 'eSign 密钥标识不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一 active 密钥' });
  }
});

export interface ProtectedESignWebhook {
  readonly payloadKeyId: string;
  readonly payloadIv: string;
  readonly payloadCiphertext: string;
  readonly payloadAuthTag: string;
}

export interface ProtectedESignIdentifier {
  readonly externalIdKeyId: string;
  readonly externalIdIv: string;
  readonly externalIdCiphertext: string;
  readonly externalIdAuthTag: string;
}

/** eSign Webhook 原始字节加密；AAD 绑定租户与 Inbox ID。 */
@Injectable()
export class ESignWebhookCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(tenantId: string, inboxId: string, rawBody: Buffer): ProtectedESignWebhook {
    this.assertContext(tenantId, inboxId);
    if (rawBody.length < 2 || rawBody.length > MAX_BODY_BYTES) throw invalidPayload();
    const ring = this.ring();
    const active = ring.keys.find((key) => key.keyId === ring.activeKeyId);
    if (active === undefined) throw invalidKeyRing();
    const master = this.decodeKey(active.keyBase64url);
    const key = this.derive(master);
    const iv = randomBytes(IV_BYTES);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(this.aad(tenantId, inboxId));
      const ciphertext = Buffer.concat([cipher.update(rawBody), cipher.final()]);
      return Object.freeze({
        payloadKeyId: active.keyId,
        payloadIv: iv.toString('base64url'),
        payloadCiphertext: ciphertext.toString('base64url'),
        payloadAuthTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  unprotect(
    tenantId: string,
    inboxId: string,
    payload: ProtectedESignWebhook,
  ): Buffer {
    this.assertContext(tenantId, inboxId);
    if (
      !ID_PATTERN.test(payload.payloadKeyId) || !BASE64URL_PATTERN.test(payload.payloadIv) ||
      !BASE64URL_PATTERN.test(payload.payloadCiphertext) ||
      !BASE64URL_PATTERN.test(payload.payloadAuthTag)
    ) throw invalidPayload();
    const iv = Buffer.from(payload.payloadIv, 'base64url');
    const ciphertext = Buffer.from(payload.payloadCiphertext, 'base64url');
    const tag = Buffer.from(payload.payloadAuthTag, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length > MAX_BODY_BYTES) {
      throw invalidPayload();
    }
    const ring = this.ring();
    const candidate = ring.keys.find((key) => key.keyId === payload.payloadKeyId);
    if (candidate === undefined) throw new Error('ESIGN_WEBHOOK_KEY_UNAVAILABLE');
    const master = this.decodeKey(candidate.keyBase64url);
    const key = this.derive(master);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(this.aad(tenantId, inboxId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length < 2 || plaintext.length > MAX_BODY_BYTES) throw invalidPayload();
      return plaintext;
    } catch (error) {
      if (error instanceof Error && error.message === 'ESIGN_WEBHOOK_PAYLOAD_INVALID') throw error;
      throw invalidPayload();
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  /** 加密供应商流程标识，明文不落库也不进入日志。 */
  protectExternalId(tenantId: string, flowId: string, externalId: string): ProtectedESignIdentifier {
    this.assertContext(tenantId, flowId);
    const plaintext = Buffer.from(externalId, 'utf8');
    if (plaintext.length < 1 || plaintext.length > MAX_IDENTIFIER_BYTES) throw invalidPayload();
    const protectedValue = this.encrypt(
      plaintext, this.identifierAad(tenantId, flowId), 'external-id-encryption-v1',
    );
    return Object.freeze({
      externalIdKeyId: protectedValue.keyId,
      externalIdIv: protectedValue.iv,
      externalIdCiphertext: protectedValue.ciphertext,
      externalIdAuthTag: protectedValue.authTag,
    });
  }

  /** 只在受信任的 eSign Adapter 调用时解密外部流程标识。 */
  unprotectExternalId(
    tenantId: string,
    flowId: string,
    payload: ProtectedESignIdentifier,
  ): string {
    this.assertContext(tenantId, flowId);
    const plaintext = this.decrypt({
      keyId: payload.externalIdKeyId,
      iv: payload.externalIdIv,
      ciphertext: payload.externalIdCiphertext,
      authTag: payload.externalIdAuthTag,
    }, this.identifierAad(tenantId, flowId), 'external-id-encryption-v1', MAX_IDENTIFIER_BYTES);
    const externalId = plaintext.toString('utf8');
    if (Buffer.from(externalId, 'utf8').length !== plaintext.length) throw invalidPayload();
    return externalId;
  }

  private encrypt(
    plaintext: Buffer,
    aad: Buffer,
    purpose: string,
  ): { readonly keyId: string; readonly iv: string; readonly ciphertext: string; readonly authTag: string } {
    const ring = this.ring();
    const active = ring.keys.find((key) => key.keyId === ring.activeKeyId);
    if (active === undefined) throw invalidKeyRing();
    const master = this.decodeKey(active.keyBase64url);
    const key = this.deriveForPurpose(master, purpose);
    const iv = randomBytes(IV_BYTES);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        keyId: active.keyId,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  private decrypt(
    payload: { readonly keyId: string; readonly iv: string; readonly ciphertext: string; readonly authTag: string },
    aad: Buffer,
    purpose: string,
    maxBytes: number,
  ): Buffer {
    if (
      !ID_PATTERN.test(payload.keyId) || !BASE64URL_PATTERN.test(payload.iv) ||
      !BASE64URL_PATTERN.test(payload.ciphertext) || !BASE64URL_PATTERN.test(payload.authTag)
    ) throw invalidPayload();
    const iv = Buffer.from(payload.iv, 'base64url');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64url');
    const tag = Buffer.from(payload.authTag, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length > maxBytes) {
      throw invalidPayload();
    }
    const ring = this.ring();
    const candidate = ring.keys.find((key) => key.keyId === payload.keyId);
    if (candidate === undefined) throw new Error('ESIGN_WEBHOOK_KEY_UNAVAILABLE');
    const master = this.decodeKey(candidate.keyBase64url);
    const key = this.deriveForPurpose(master, purpose);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length < 1 || plaintext.length > maxBytes) throw invalidPayload();
      return plaintext;
    } catch (error) {
      if (error instanceof Error && error.message === 'ESIGN_WEBHOOK_PAYLOAD_INVALID') throw error;
      throw invalidPayload();
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  private ring(): z.infer<typeof keyRingSchema> {
    const raw = this.config.get('ESIGN_WEBHOOK_ENCRYPTION_KEYS', { infer: true });
    if (raw === undefined) throw invalidKeyRing();
    try {
      const parsed = keyRingSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      // 返回稳定错误，禁止泄露 Secret 配置。
    }
    throw invalidKeyRing();
  }

  private decodeKey(value: string): Buffer {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) throw invalidKeyRing();
    return decoded;
  }

  private derive(master: Buffer): Buffer {
    return this.deriveForPurpose(master, 'payload-encryption-v1');
  }

  private deriveForPurpose(master: Buffer, purpose: string): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('gaoq-esign-webhook-v1'), Buffer.from(purpose), 32,
    ));
  }

  private aad(tenantId: string, inboxId: string): Buffer {
    return Buffer.from(JSON.stringify(['gaoq-esign-webhook-v1', tenantId, inboxId]), 'utf8');
  }

  private identifierAad(tenantId: string, flowId: string): Buffer {
    return Buffer.from(JSON.stringify(['gaoq-esign-external-id-v1', tenantId, flowId]), 'utf8');
  }

  private assertContext(tenantId: string, inboxId: string): void {
    if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(inboxId)) throw invalidPayload();
  }
}

function invalidKeyRing(): Error {
  return new Error('ESIGN_WEBHOOK_KEY_RING_INVALID');
}

function invalidPayload(): Error {
  return new Error('ESIGN_WEBHOOK_PAYLOAD_INVALID');
}
