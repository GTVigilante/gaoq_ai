import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ringSchema = z.object({
  activeKeyId: z.string().regex(ID),
  keys: z.array(z.object({
    keyId: z.string().regex(ID),
    keyBase64url: z.string().regex(KEY),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((item) => item.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '动态表单密钥标识不得重复' });
  }
  const active = ring.keys.filter((item) => item.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一活动密钥' });
  }
});

export interface ProtectedDynamicFormData {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface DynamicFormCryptoContext {
  readonly tenantId: string;
  readonly formId: string;
  readonly recordId: string;
  readonly formRevision: number;
}

/** 动态表单记录静态加密；密钥域与审批、招聘、工资完全隔离。 */
@Injectable()
export class DynamicFormDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: DynamicFormCryptoContext, values: Readonly<Record<string, unknown>>): ProtectedDynamicFormData {
    this.assertContext(context);
    const ring = this.ring();
    const selected = ring.keys.find((item) => item.keyId === ring.activeKeyId);
    if (selected === undefined) throw invalidKeyRing();
    const master = decodeKey(selected.keyBase64url);
    const key = derive(master);
    const iv = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(values), 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        keyId: selected.keyId,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      master.fill(0); key.fill(0); plaintext.fill(0);
    }
  }

  unprotect(context: DynamicFormCryptoContext, payload: ProtectedDynamicFormData): unknown {
    this.assertContext(context);
    if (!ID.test(payload.keyId) || !BASE64URL.test(payload.iv) || !BASE64URL.test(payload.ciphertext) || !BASE64URL.test(payload.authTag)) throw invalidCiphertext();
    const iv = Buffer.from(payload.iv, 'base64url');
    const authTag = Buffer.from(payload.authTag, 'base64url');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64url');
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > 700 * 1_024) throw invalidCiphertext();
    const selected = this.ring().keys.find((item) => item.keyId === payload.keyId);
    if (selected === undefined) throw invalidCiphertext();
    const master = decodeKey(selected.keyBase64url);
    const key = derive(master);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(aad(context)); decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw invalidCiphertext();
    } finally {
      master.fill(0); key.fill(0); plaintext?.fill(0);
    }
  }

  private ring(): z.infer<typeof ringSchema> {
    const raw = this.config.get('FORM_DATA_ENCRYPTION_KEYS', { infer: true });
    if (raw === undefined) throw invalidKeyRing();
    try {
      const parsed = ringSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) return parsed.data;
    } catch { /* 统一映射为稳定错误码。 */ }
    throw invalidKeyRing();
  }

  private assertContext(context: DynamicFormCryptoContext): void {
    if (!ID.test(context.tenantId) || !ID.test(context.formId) || !ID.test(context.recordId) || !Number.isSafeInteger(context.formRevision) || context.formRevision < 1) throw invalidCiphertext();
  }
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) throw invalidKeyRing();
  return key;
}

function derive(master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('gaoq-dynamic-form-v1'), Buffer.from('record-data-encryption-v1'), 32));
}

function aad(context: DynamicFormCryptoContext): Buffer {
  return Buffer.from(JSON.stringify(['gaoq-dynamic-form-v1', context.tenantId, context.formId, context.recordId, context.formRevision]));
}

function invalidKeyRing(): Error { return new Error('FORM_DATA_KEY_RING_INVALID'); }
function invalidCiphertext(): Error { return new Error('FORM_DATA_CIPHERTEXT_INVALID'); }
