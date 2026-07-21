import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import { RecruitmentDomainError } from '../domain/recruitment.errors.js';
import { RECRUITMENT_ID_PATTERN } from '../domain/recruitment.validation.js';

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const encryptionRingSchema = z.object({
  activeKeyId: z.string().regex(RECRUITMENT_ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(RECRUITMENT_ID_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '招聘加密 keyId 不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一 active 密钥' });
  }
});

const blindIndexRingSchema = z.object({
  activeKeyId: z.string().regex(RECRUITMENT_ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(RECRUITMENT_ID_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'lookup_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '招聘盲索引 keyId 不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一 active 密钥' });
  }
});

export interface RecruitmentCryptoContext {
  readonly tenantId: string;
  readonly resourceType:
    | 'candidate_identity'
    | 'offer_terms'
    | 'interview_location'
    | 'interview_feedback'
    | 'channel_inbox'
    | 'channel_cursor'
    | 'channel_mapping';
  readonly resourceId: string;
}

export interface ProtectedRecruitmentData {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

type EncryptionRing = z.infer<typeof encryptionRingSchema>;
type BlindIndexRing = z.infer<typeof blindIndexRingSchema>;

/** 招聘敏感数据加密和精确去重盲索引；两个密钥域独立轮换。 */
@Injectable()
export class RecruitmentDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: RecruitmentCryptoContext, value: unknown): ProtectedRecruitmentData {
    this.assertContext(context);
    const ring = this.loadEncryptionRing();
    const key = ring.keys.find((candidate) => candidate.keyId === ring.activeKeyId);
    if (key === undefined) throw this.invalidKeyRing();
    const masterKey = this.decodeKey(key.keyBase64url);
    const encryptionKey = this.deriveEncryptionKey(masterKey);
    const iv = randomBytes(AES_GCM_IV_BYTES);
    let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      if (plaintext.length > MAX_PLAINTEXT_BYTES) throw this.invalidPayload();
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      cipher.setAAD(this.aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        keyId: key.keyId,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } catch (error) {
      if (error instanceof RecruitmentDomainError) throw error;
      throw this.invalidPayload();
    } finally {
      plaintext?.fill(0);
      masterKey.fill(0);
      encryptionKey.fill(0);
    }
  }

  unprotect(context: RecruitmentCryptoContext, data: ProtectedRecruitmentData): unknown {
    this.assertContext(context);
    if (
      !RECRUITMENT_ID_PATTERN.test(data.keyId) ||
      !BASE64URL_PATTERN.test(data.iv) ||
      !BASE64URL_PATTERN.test(data.ciphertext) ||
      !BASE64URL_PATTERN.test(data.authTag)
    ) throw this.invalidPayload();
    const iv = this.decodeBase64Url(data.iv);
    const ciphertext = this.decodeBase64Url(data.ciphertext);
    const authTag = this.decodeBase64Url(data.authTag);
    if (
      iv.length !== AES_GCM_IV_BYTES || authTag.length !== AES_GCM_TAG_BYTES ||
      ciphertext.length > MAX_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES
    ) throw this.invalidPayload();
    const ring = this.loadEncryptionRing();
    const key = ring.keys.find((candidate) => candidate.keyId === data.keyId);
    if (key === undefined) throw new RecruitmentDomainError(
      'RECRUITMENT_DATA_KEY_UNAVAILABLE', '招聘数据解密密钥不可用',
    );
    const masterKey = this.decodeKey(key.keyBase64url);
    const encryptionKey = this.deriveEncryptionKey(masterKey);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw this.invalidPayload();
    } finally {
      plaintext?.fill(0);
      masterKey.fill(0);
      encryptionKey.fill(0);
    }
  }

  blindIndexes(tenantId: string, field: 'phone' | 'email', normalizedValue: string): readonly string[] {
    this.assertContext({ tenantId, resourceType: 'candidate_identity', resourceId: 'blind-index' });
    if (normalizedValue.length < 3 || normalizedValue.length > 254) throw this.invalidPayload();
    const ring = this.loadBlindIndexRing();
    return Object.freeze(ring.keys.map((key) => {
      const rawKey = this.decodeKey(key.keyBase64url);
      try {
        const digest = createHmac('sha256', rawKey)
          .update(JSON.stringify(['gaoq-recruitment-blind-index-v1', tenantId, field, normalizedValue]))
          .digest('base64url');
        return `${key.keyId}.${digest}`;
      } finally {
        rawKey.fill(0);
      }
    }));
  }

  /** 渠道外部标识使用独立域分隔的可轮换盲指纹，不保存可枚举明文哈希。 */
  channelFingerprints(
    tenantId: string,
    namespace: 'event' | 'position' | 'candidate' | 'application',
    channelCode: string,
    externalId: string,
  ): readonly string[] {
    this.assertContext({ tenantId, resourceType: 'channel_mapping', resourceId: 'blind-index' });
    if (
      !/^[a-z][a-z0-9_]{1,31}$/.test(channelCode) ||
      externalId.length < 1 || externalId.length > 256
    ) throw this.invalidPayload();
    const ring = this.loadBlindIndexRing();
    return Object.freeze(ring.keys.map((key) => {
      const rawKey = this.decodeKey(key.keyBase64url);
      try {
        const digest = createHmac('sha256', rawKey).update(JSON.stringify([
          'gaoq-recruitment-channel-fingerprint-v1', tenantId, namespace, channelCode, externalId,
        ])).digest('base64url');
        return `${key.keyId}.${digest}`;
      } finally {
        rawKey.fill(0);
      }
    }));
  }

  private loadEncryptionRing(): EncryptionRing {
    return this.parseRing(
      this.config.get('RECRUITMENT_DATA_ENCRYPTION_KEYS', { infer: true }),
      encryptionRingSchema,
    );
  }

  private loadBlindIndexRing(): BlindIndexRing {
    return this.parseRing(
      this.config.get('RECRUITMENT_BLIND_INDEX_KEYS', { infer: true }),
      blindIndexRingSchema,
    );
  }

  private parseRing<T>(raw: string | undefined, schema: z.ZodType<T>): T {
    if (raw === undefined) throw this.invalidKeyRing();
    try {
      const parsed = schema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      // 统一返回稳定错误，不暴露密钥配置内容。
    }
    throw this.invalidKeyRing();
  }

  private decodeKey(encoded: string): Buffer {
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw this.invalidKeyRing();
    return key;
  }

  private decodeBase64Url(encoded: string): Buffer {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw this.invalidPayload();
    return decoded;
  }

  private deriveEncryptionKey(masterKey: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', masterKey, Buffer.from('gaoq-recruitment-data-v1', 'utf8'),
      Buffer.from('sensitive-data-encryption-v1', 'utf8'), 32,
    ));
  }

  private aad(context: RecruitmentCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-recruitment-data-v1', context.tenantId, context.resourceType, context.resourceId,
    ]), 'utf8');
  }

  private assertContext(context: RecruitmentCryptoContext): void {
    if (
      !RECRUITMENT_ID_PATTERN.test(context.tenantId) ||
      !RECRUITMENT_ID_PATTERN.test(context.resourceId) ||
      ![
        'candidate_identity', 'offer_terms', 'interview_location', 'interview_feedback',
        'channel_inbox', 'channel_cursor', 'channel_mapping',
      ].includes(context.resourceType)
    ) throw this.invalidPayload();
  }

  private invalidKeyRing(): RecruitmentDomainError {
    return new RecruitmentDomainError(
      'RECRUITMENT_DATA_KEY_RING_INVALID', '招聘数据密钥环无效',
    );
  }

  private invalidPayload(): RecruitmentDomainError {
    return new RecruitmentDomainError(
      'RECRUITMENT_DATA_CIPHERTEXT_INVALID', '招聘数据密文或上下文无效',
    );
  }
}
