import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER_TYPE = /^(national_id|passport|unified_social_credit_code|business_registration_no)$/;
const IDENTIFIER = /^[A-Za-z0-9]{6,32}$/;

const encryptionRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_ID),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_ID), keyBase64url: z.string().regex(KEY),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => validateRing(ring, 'decrypt_only', context));

const blindRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_ID),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_ID), keyBase64url: z.string().regex(KEY),
    status: z.enum(['active', 'lookup_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => validateRing(ring, 'lookup_only', context));

export interface SupplierLegalIdentity {
  readonly identifierType: 'national_id' | 'passport' | 'unified_social_credit_code' | 'business_registration_no';
  readonly identifier: string;
  readonly legalName: string;
}

export interface ProtectedSupplierIdentity {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface SupplierCryptoContext {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly version: number;
}

/** 供应方法定身份的独立 AES-256-GCM 加密与 HMAC 盲索引模块。 */
@Injectable()
export class SupplierDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: SupplierCryptoContext, identity: SupplierLegalIdentity): ProtectedSupplierIdentity {
    this.assertContext(context); const normalized = normalizeIdentity(identity);
    const configured = activeKey(this.encryptionRing()); const master = decodeKey(configured.keyBase64url);
    const key = derive(master); const iv = randomBytes(12); let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(normalized), 'utf8');
      if (plaintext.length > 2_048) throw invalidCiphertext();
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({ keyId: configured.keyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url') });
    } finally { plaintext?.fill(0); key.fill(0); master.fill(0); }
  }

  unprotect(context: SupplierCryptoContext, payload: ProtectedSupplierIdentity): SupplierLegalIdentity {
    this.assertContext(context);
    if (!KEY_ID.test(payload.keyId) || !BASE64URL.test(payload.iv) || !BASE64URL.test(payload.ciphertext) || !BASE64URL.test(payload.authTag)) throw invalidCiphertext();
    const iv = Buffer.from(payload.iv, 'base64url'); const ciphertext = Buffer.from(payload.ciphertext, 'base64url'); const tag = Buffer.from(payload.authTag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 2_048) throw invalidCiphertext();
    const configured = this.encryptionRing().keys.find((item) => item.keyId === payload.keyId);
    if (configured === undefined) throw new Error('SUPPLIER_DATA_KEY_UNAVAILABLE');
    const master = decodeKey(configured.keyBase64url); const key = derive(master); let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(aad(context)); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return normalizeIdentity(JSON.parse(plaintext.toString('utf8')) as SupplierLegalIdentity);
    } catch { throw invalidCiphertext(); }
    finally { plaintext?.fill(0); key.fill(0); master.fill(0); }
  }

  /** 返回活动与轮换期查询密钥的全部指纹；首项始终由活动密钥产生。 */
  identityFingerprints(tenantId: string, identity: SupplierLegalIdentity): readonly string[] {
    if (!ID.test(tenantId)) throw invalidIdentity();
    const normalized = normalizeIdentity(identity); const ring = this.blindRing();
    const ordered = [...ring.keys].sort((left, right) => Number(right.keyId === ring.activeKeyId) - Number(left.keyId === ring.activeKeyId));
    return Object.freeze(ordered.map((configured) => {
      const key = decodeKey(configured.keyBase64url);
      try {
        const digest = createHmac('sha256', key).update(JSON.stringify(['gaoq-supplier-identity-v1', tenantId, normalized.identifierType, normalized.identifier]), 'utf8').digest('base64url');
        return `${configured.keyId}.${digest}`;
      } finally { key.fill(0); }
    }));
  }

  identityHint(identity: SupplierLegalIdentity): string {
    const normalized = normalizeIdentity(identity);
    return `****${normalized.identifier.slice(-4)}`;
  }

  private encryptionRing(): z.infer<typeof encryptionRingSchema> { return parseRing(this.config.get('SUPPLIER_DATA_ENCRYPTION_KEYS', { infer: true }), encryptionRingSchema); }
  private blindRing(): z.infer<typeof blindRingSchema> { return parseRing(this.config.get('SUPPLIER_BLIND_INDEX_KEYS', { infer: true }), blindRingSchema); }
  private assertContext(value: SupplierCryptoContext): void { if (!ID.test(value.tenantId) || !ID.test(value.supplierId) || !Number.isSafeInteger(value.version) || value.version < 1) throw invalidCiphertext(); }
}

function normalizeIdentity(value: SupplierLegalIdentity): SupplierLegalIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 3) throw invalidIdentity();
  const identifierType = value.identifierType; const identifier = value.identifier?.replace(/[\s-]/gu, '').toUpperCase(); const legalName = value.legalName?.trim().normalize('NFC');
  if (!IDENTIFIER_TYPE.test(identifierType) || !IDENTIFIER.test(identifier) || typeof legalName !== 'string' || legalName.length < 2 || legalName.length > 128 || containsControlCharacter(legalName)) throw invalidIdentity();
  return Object.freeze({ identifierType, identifier, legalName });
}
function containsControlCharacter(value: string): boolean { return Array.from(value).some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); }
function validateRing(ring: { activeKeyId: string; keys: readonly { keyId: string; status: string }[] }, _secondary: string, context: z.RefinementCtx): void {
  const active = ring.keys.filter((item) => item.status === 'active');
  if (new Set(ring.keys.map((item) => item.keyId)).size !== ring.keys.length || active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) context.addIssue({ code: 'custom', message: '供应方密钥环状态非法' });
}
function parseRing<T>(raw: string | undefined, schema: z.ZodType<T>): T {
  try { if (raw !== undefined) { const parsed = schema.safeParse(JSON.parse(raw) as unknown); if (parsed.success) return parsed.data; } } catch { /* 统一稳定错误码。 */ }
  throw new Error('SUPPLIER_KEY_RING_INVALID');
}
function activeKey<T extends { activeKeyId: string; keys: readonly { keyId: string; keyBase64url: string }[] }>(ring: T): T['keys'][number] { const found = ring.keys.find((item) => item.keyId === ring.activeKeyId); if (found === undefined) throw new Error('SUPPLIER_KEY_RING_INVALID'); return found; }
function decodeKey(value: string): Buffer { const key = Buffer.from(value, 'base64url'); if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('SUPPLIER_KEY_RING_INVALID'); return key; }
function derive(master: Buffer): Buffer { return Buffer.from(hkdfSync('sha256', master, Buffer.from('gaoq-supplier-v1'), Buffer.from('legal-identity-encryption-v1'), 32)); }
function aad(value: SupplierCryptoContext): Buffer { return Buffer.from(JSON.stringify(['gaoq-supplier-v1', value.tenantId, value.supplierId, value.version]), 'utf8'); }
function invalidIdentity(): Error { return new Error('SUPPLIER_LEGAL_IDENTITY_INVALID'); }
function invalidCiphertext(): Error { return new Error('SUPPLIER_IDENTITY_CIPHERTEXT_INVALID'); }
