import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgSecretResolver } from './org-platform-credential.service.js';
import type { OrgPushChannel } from './org-push.adapter.js';
import { OrgPushError } from './org-push.adapter.js';

const PROVISIONING_KEY_SECRET_REF = 'GAOQ_ORG_PROVISIONING_ENCRYPTION_KEYS';
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

const keyRingSchema = z.object({
  activeKeyId: z.string().regex(ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(ID_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  const ids = new Set(ring.keys.map((key) => key.keyId));
  if (ids.size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '加密密钥 keyId 不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须精确指向唯一 active 密钥' });
  }
});

const contactSchema = z.object({
  email: z.string().email().max(254).optional(),
  mobile: z.object({
    countryCode: z.string().regex(/^\+[1-9]\d{0,3}$/),
    subscriberNumber: z.string().regex(/^[1-9]\d{5,14}$/),
  }).strict().refine(
    (mobile) => mobile.countryCode.length - 1 + mobile.subscriberNumber.length <= 15,
  ).optional(),
}).strict().refine((contact) => contact.email !== undefined || contact.mobile !== undefined);

export interface OrgProvisioningContact {
  readonly email?: string;
  readonly mobile?: {
    readonly countryCode: string;
    readonly subscriberNumber: string;
  };
}

export interface OrgProvisioningCryptoContext {
  readonly tenantId: string;
  readonly requestId: string;
  readonly employeeId: string;
  readonly channel: OrgPushChannel;
}

export interface ProtectedOrgProvisioningPayload {
  readonly payloadKeyId: string;
  readonly inputDigest: string;
  readonly payloadIv: string;
  readonly payloadCiphertext: string;
  readonly payloadAuthTag: string;
}

export interface StoredOrgProvisioningPayload extends OrgProvisioningCryptoContext {
  readonly payloadKeyId: string;
  readonly payloadIv: string;
  readonly payloadCiphertext: string;
  readonly payloadAuthTag: string;
}

interface ParsedKeyRing {
  readonly activeKeyId: string;
  readonly keys: readonly {
    readonly keyId: string;
    readonly keyBase64url: string;
    readonly status: 'active' | 'decrypt_only';
  }[];
}

/**
 * 私密开户资料保护服务。
 * 主密钥仅由受控 Secret 引用按需解析；Mongo 只保存 AES-256-GCM 密文与带密钥摘要。
 */
@Injectable()
export class OrgProvisioningCryptoService {
  constructor(private readonly secrets: OrgSecretResolver) {}

  async protect(
    context: OrgProvisioningCryptoContext,
    untrustedContact: unknown,
  ): Promise<ProtectedOrgProvisioningPayload> {
    this.assertContext(context);
    const contact = this.parseContact(untrustedContact);
    try {
      const ring = await this.loadRing();
      const key = this.keyById(ring, ring.activeKeyId);
      const masterKey = this.decodeKey(key.keyBase64url);
      const encryptionKey = this.deriveKey(masterKey, 'payload-encryption-v1');
      const digestKey = this.deriveKey(masterKey, 'input-digest-v1');
      const iv = randomBytes(AES_GCM_IV_BYTES);
      const plaintext = Buffer.from(JSON.stringify(contact), 'utf8');
      try {
        const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, {
          authTagLength: AES_GCM_TAG_BYTES,
        });
        cipher.setAAD(this.aad(context));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return Object.freeze({
          payloadKeyId: key.keyId,
          inputDigest: this.digest(digestKey, context, contact),
          payloadIv: iv.toString('base64url'),
          payloadCiphertext: ciphertext.toString('base64url'),
          payloadAuthTag: authTag.toString('base64url'),
        });
      } finally {
        plaintext.fill(0);
        masterKey.fill(0);
        encryptionKey.fill(0);
        digestKey.fill(0);
      }
    } finally {
      this.erase(contact);
    }
  }

  async matchesDigest(
    context: Omit<OrgProvisioningCryptoContext, 'requestId'>,
    keyId: string,
    expectedDigest: string,
    untrustedContact: unknown,
  ): Promise<boolean> {
    this.assertIdentityContext(context);
    if (!ID_PATTERN.test(keyId) || !BASE64URL_256_PATTERN.test(expectedDigest)) return false;
    const contact = this.parseContact(untrustedContact);
    try {
      const ring = await this.loadRing();
      const key = this.keyById(ring, keyId);
      const masterKey = this.decodeKey(key.keyBase64url);
      const digestKey = this.deriveKey(masterKey, 'input-digest-v1');
      try {
        const actual = Buffer.from(this.digest(digestKey, context, contact), 'base64url');
        const expected = Buffer.from(expectedDigest, 'base64url');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      } finally {
        masterKey.fill(0);
        digestKey.fill(0);
      }
    } finally {
      this.erase(contact);
    }
  }

  async unprotect(payload: StoredOrgProvisioningPayload): Promise<OrgProvisioningContact> {
    this.assertContext(payload);
    if (
      !ID_PATTERN.test(payload.payloadKeyId) ||
      !BASE64URL_PATTERN.test(payload.payloadIv) ||
      !BASE64URL_PATTERN.test(payload.payloadCiphertext) ||
      !BASE64URL_PATTERN.test(payload.payloadAuthTag)
    ) throw this.invalidPayload();
    const iv = Buffer.from(payload.payloadIv, 'base64url');
    const ciphertext = Buffer.from(payload.payloadCiphertext, 'base64url');
    const authTag = Buffer.from(payload.payloadAuthTag, 'base64url');
    if (iv.length !== AES_GCM_IV_BYTES || authTag.length !== AES_GCM_TAG_BYTES) {
      throw this.invalidPayload();
    }
    const ring = await this.loadRing();
    const key = this.keyById(ring, payload.payloadKeyId);
    const masterKey = this.decodeKey(key.keyBase64url);
    const encryptionKey = this.deriveKey(masterKey, 'payload-encryption-v1');
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(this.aad(payload));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return this.parseContact(JSON.parse(plaintext.toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof OrgPushError) throw error;
      throw this.invalidPayload();
    } finally {
      plaintext?.fill(0);
      masterKey.fill(0);
      encryptionKey.fill(0);
    }
  }

  /** 尽力缩短 Worker 中解密字段的可达时间；JS 不保证字符串内存可清零。 */
  erase(contact: OrgProvisioningContact): void {
    const mutable = contact as {
      email?: string;
      mobile?: { countryCode: string; subscriberNumber: string };
    };
    if (mutable.mobile !== undefined) {
      mutable.mobile.countryCode = '';
      mutable.mobile.subscriberNumber = '';
      delete mutable.mobile;
    }
    if (mutable.email !== undefined) {
      mutable.email = '';
      delete mutable.email;
    }
  }

  private async loadRing(): Promise<ParsedKeyRing> {
    const raw = await this.secrets.resolve(PROVISIONING_KEY_SECRET_REF);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw this.invalidKeyRing();
    }
    const parsed = keyRingSchema.safeParse(decoded);
    if (!parsed.success) throw this.invalidKeyRing();
    return parsed.data;
  }

  private keyById(ring: ParsedKeyRing, keyId: string): ParsedKeyRing['keys'][number] {
    const key = ring.keys.find((candidate) => candidate.keyId === keyId);
    if (key === undefined) {
      throw new OrgPushError(
        'ORG_PROVISIONING_KEY_UNAVAILABLE',
        'retryable',
        '私密资料解密密钥暂不可用',
      );
    }
    return key;
  }

  private decodeKey(encoded: string): Buffer {
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw this.invalidKeyRing();
    return key;
  }

  private deriveKey(masterKey: Buffer, purpose: string): Buffer {
    return Buffer.from(hkdfSync(
      'sha256',
      masterKey,
      Buffer.from('gaoq-org-provisioning-v1', 'utf8'),
      Buffer.from(purpose, 'utf8'),
      32,
    ));
  }

  private digest(
    digestKey: Buffer,
    context: Omit<OrgProvisioningCryptoContext, 'requestId'>,
    contact: OrgProvisioningContact,
  ): string {
    const canonical = JSON.stringify([
      context.tenantId,
      context.employeeId,
      context.channel,
      contact.email ?? null,
      contact.mobile?.countryCode ?? null,
      contact.mobile?.subscriberNumber ?? null,
    ]);
    return createHmac('sha256', digestKey).update(canonical, 'utf8').digest('base64url');
  }

  private aad(context: OrgProvisioningCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-org-provisioning-v1',
      context.tenantId,
      context.requestId,
      context.employeeId,
      context.channel,
    ]), 'utf8');
  }

  private parseContact(value: unknown): OrgProvisioningContact {
    const parsed = contactSchema.safeParse(value);
    if (!parsed.success) {
      throw new OrgPushError('ORG_PROVISIONING_CONTACT_INVALID', 'business', '开户联系方式无效');
    }
    return {
      ...(parsed.data.email === undefined ? {} : { email: parsed.data.email.trim().toLowerCase() }),
      ...(parsed.data.mobile === undefined ? {} : { mobile: { ...parsed.data.mobile } }),
    };
  }

  private assertContext(context: OrgProvisioningCryptoContext): void {
    this.assertIdentityContext(context);
    if (!ID_PATTERN.test(context.requestId)) throw this.invalidPayload();
  }

  private assertIdentityContext(
    context: Omit<OrgProvisioningCryptoContext, 'requestId'>,
  ): void {
    if (
      !ID_PATTERN.test(context.tenantId) ||
      !ID_PATTERN.test(context.employeeId) ||
      (context.channel !== 'dingtalk' && context.channel !== 'feishu')
    ) throw this.invalidPayload();
  }

  private invalidPayload(): OrgPushError {
    return new OrgPushError('ORG_PROVISIONING_PAYLOAD_INVALID', 'business', '私密开户资料无效');
  }

  private invalidKeyRing(): OrgPushError {
    return new OrgPushError('ORG_PROVISIONING_KEY_INVALID', 'business', '私密资料加密密钥配置无效');
  }
}
