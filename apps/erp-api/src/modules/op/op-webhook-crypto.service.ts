import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { OP_MAX_WEBHOOK_BODY_BYTES } from './op-operating-summary.contract.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const keyRingSchema = z.object({
  activeKeyId: z.string().regex(ID),
  keys: z.array(z.object({
    keyId: z.string().regex(ID), keyBase64url: z.string().regex(KEY),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: 'OP 密钥标识不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一 active 密钥' });
  }
});

export interface ProtectedOpWebhook {
  readonly payloadKeyId: string;
  readonly payloadIv: string;
  readonly payloadCiphertext: string;
  readonly payloadAuthTag: string;
}

/** OP 原始请求 AES-256-GCM 加密，AAD 固定绑定租户与 Inbox ID。 */
@Injectable()
export class OpWebhookCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(tenantId: string, inboxId: string, rawBody: Buffer): ProtectedOpWebhook {
    this.assertInput(tenantId, inboxId, rawBody);
    const ring = this.ring();
    const active = ring.keys.find((item) => item.keyId === ring.activeKeyId);
    if (active === undefined) throw unavailable();
    const master = this.decode(active.keyBase64url);
    const key = this.derive(master);
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(this.aad(tenantId, inboxId));
      const ciphertext = Buffer.concat([cipher.update(rawBody), cipher.final()]);
      return Object.freeze({
        payloadKeyId: active.keyId, payloadIv: iv.toString('base64url'),
        payloadCiphertext: ciphertext.toString('base64url'),
        payloadAuthTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  unprotect(tenantId: string, inboxId: string, payload: ProtectedOpWebhook): Buffer {
    if (!ID.test(tenantId) || !ID.test(inboxId) || !ID.test(payload.payloadKeyId) ||
      !BASE64URL.test(payload.payloadIv) || !BASE64URL.test(payload.payloadCiphertext) ||
      !BASE64URL.test(payload.payloadAuthTag)) throw new Error('OP_WEBHOOK_PAYLOAD_INVALID');
    const iv = Buffer.from(payload.payloadIv, 'base64url');
    const ciphertext = Buffer.from(payload.payloadCiphertext, 'base64url');
    const tag = Buffer.from(payload.payloadAuthTag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > OP_MAX_WEBHOOK_BODY_BYTES) {
      throw new Error('OP_WEBHOOK_PAYLOAD_INVALID');
    }
    const item = this.ring().keys.find((candidate) => candidate.keyId === payload.payloadKeyId);
    if (item === undefined) throw new Error('OP_WEBHOOK_KEY_UNAVAILABLE');
    const master = this.decode(item.keyBase64url);
    const key = this.derive(master);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(this.aad(tenantId, inboxId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length < 2 || plaintext.length > OP_MAX_WEBHOOK_BODY_BYTES) {
        throw new Error('OP_WEBHOOK_PAYLOAD_INVALID');
      }
      return plaintext;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OP_WEBHOOK_')) throw error;
      throw new Error('OP_WEBHOOK_PAYLOAD_INVALID', { cause: error });
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  private ring(): z.infer<typeof keyRingSchema> {
    const raw = this.config.get('OP_WEBHOOK_ENCRYPTION_KEYS', { infer: true });
    if (raw === undefined) throw unavailable();
    try {
      return keyRingSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw unavailable();
    }
  }

  private assertInput(tenantId: string, inboxId: string, body: Buffer): void {
    if (!ID.test(tenantId) || !ID.test(inboxId) || body.length < 2 ||
      body.length > OP_MAX_WEBHOOK_BODY_BYTES) throw new Error('OP_WEBHOOK_PAYLOAD_INVALID');
  }

  private decode(value: string): Buffer {
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32) throw unavailable();
    return key;
  }

  private derive(master: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('gaoq-op-webhook-v1', 'utf8'),
      Buffer.from('payload-encryption', 'utf8'), 32,
    ));
  }

  private aad(tenantId: string, inboxId: string): Buffer {
    return Buffer.from(`op-webhook\0${tenantId}\0${inboxId}`, 'utf8');
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'OP_WEBHOOK_KEYRING_UNAVAILABLE', message: 'OP 回调加密设施暂不可用',
  });
}
