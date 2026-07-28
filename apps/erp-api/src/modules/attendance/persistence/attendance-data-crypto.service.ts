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
import { AttendanceDomainError } from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const IV_BASE64URL_LENGTH = 16;
const AUTH_TAG_BASE64URL_LENGTH = 22;
const MAX_CIPHERTEXT_BASE64URL_LENGTH = Math.ceil(MAX_PLAINTEXT_BYTES * 4 / 3);

const encryptionRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  const active = ring.keys.filter((key) => key.status === 'active');
  if (
    new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length ||
    active.length !== 1 || active[0]?.keyId !== ring.activeKeyId
  ) context.addIssue({ code: 'custom', message: '考勤加密密钥环状态非法' });
});

const blindIndexRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'lookup_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  const active = ring.keys.filter((key) => key.status === 'active');
  if (
    new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length ||
    active.length !== 1 || active[0]?.keyId !== ring.activeKeyId
  ) context.addIssue({ code: 'custom', message: '考勤盲索引密钥环状态非法' });
});

export interface AttendanceCryptoContext {
  readonly tenantId: string;
  readonly resourceType:
    | 'source_fact'
    | 'correction'
    | 'monthly_snapshot'
    | 'provider_cursor'
    | 'provider_inbox'
    | 'provider_mapping';
  readonly resourceId: string;
}

export interface ProtectedAttendanceData {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

/** 考勤 L4 明细加密与外部事件盲指纹；两个密钥域独立轮换。 */
@Injectable()
export class AttendanceDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: AttendanceCryptoContext, value: unknown): ProtectedAttendanceData {
    this.assertContext(context);
    const ring = this.loadEncryptionRing();
    const configured = ring.keys.find((key) => key.keyId === ring.activeKeyId);
    if (configured === undefined) throw this.invalidKeyRing();
    const master = this.decodeKey(configured.keyBase64url);
    const key = this.deriveKey(master);
    const iv = randomBytes(12);
    let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      if (plaintext.length > MAX_PLAINTEXT_BYTES) throw this.invalidCiphertext();
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(this.aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        keyId: configured.keyId,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } catch (error) {
      if (error instanceof AttendanceDomainError) throw error;
      throw this.invalidCiphertext();
    } finally {
      plaintext?.fill(0);
      master.fill(0);
      key.fill(0);
    }
  }

  unprotect(context: AttendanceCryptoContext, value: ProtectedAttendanceData): unknown {
    this.assertContext(context);
    if (
      !KEY_PATTERN.test(value.keyId) || !BASE64URL_PATTERN.test(value.iv) ||
      value.iv.length !== IV_BASE64URL_LENGTH ||
      !BASE64URL_PATTERN.test(value.ciphertext) ||
      value.ciphertext.length > MAX_CIPHERTEXT_BASE64URL_LENGTH ||
      !BASE64URL_PATTERN.test(value.authTag) ||
      value.authTag.length !== AUTH_TAG_BASE64URL_LENGTH
    ) throw this.invalidCiphertext();
    const ring = this.loadEncryptionRing();
    const configured = ring.keys.find((key) => key.keyId === value.keyId);
    if (configured === undefined) throw new AttendanceDomainError(
      'ATTENDANCE_DATA_KEY_UNAVAILABLE', '考勤数据解密密钥不可用',
    );
    const master = this.decodeKey(configured.keyBase64url);
    const key = this.deriveKey(master);
    const iv = this.decode(value.iv);
    const ciphertext = this.decode(value.ciphertext);
    const tag = this.decode(value.authTag);
    let plaintext: Buffer | undefined;
    try {
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
        throw this.invalidCiphertext();
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw this.invalidCiphertext();
    } finally {
      plaintext?.fill(0);
      master.fill(0);
      key.fill(0);
    }
  }

  sourceEventFingerprints(
    tenantId: string,
    providerCode: string,
    externalEventId: string,
  ): readonly string[] {
    return this.blindFingerprints(
      tenantId, providerCode, externalEventId, 'gaoq-attendance-source-event-v1',
    );
  }

  /** Provider 外部事件与员工标识使用相互隔离的盲索引命名空间。 */
  providerFingerprints(
    tenantId: string,
    namespace: 'event' | 'employee',
    providerCode: string,
    externalId: string,
  ): readonly string[] {
    return this.blindFingerprints(
      tenantId, providerCode, externalId, `gaoq-attendance-provider-${namespace}-v1`,
    );
  }

  private blindFingerprints(
    tenantId: string,
    providerCode: string,
    externalId: string,
    domain: string,
  ): readonly string[] {
    this.assertContext({ tenantId, resourceType: 'source_fact', resourceId: 'blind-index' });
    if (!ID_PATTERN.test(providerCode) || externalId.length < 1 || externalId.length > 256) {
      throw this.invalidCiphertext();
    }
    const ring = this.loadBlindIndexRing();
    return Object.freeze(ring.keys.map((configured) => {
      const key = this.decodeKey(configured.keyBase64url);
      try {
        return `${configured.keyId}.${createHmac('sha256', key).update(JSON.stringify([
          domain, tenantId, providerCode, externalId,
        ])).digest('base64url')}`;
      } finally {
        key.fill(0);
      }
    }));
  }

  private loadEncryptionRing(): z.infer<typeof encryptionRingSchema> {
    return this.parseRing(
      this.config.get('ATTENDANCE_DATA_ENCRYPTION_KEYS', { infer: true }),
      encryptionRingSchema,
    );
  }

  private loadBlindIndexRing(): z.infer<typeof blindIndexRingSchema> {
    return this.parseRing(
      this.config.get('ATTENDANCE_BLIND_INDEX_KEYS', { infer: true }),
      blindIndexRingSchema,
    );
  }

  private parseRing<T>(raw: string | undefined, schema: z.ZodType<T>): T {
    if (raw !== undefined) {
      try {
        const result = schema.safeParse(JSON.parse(raw) as unknown);
        if (result.success) return result.data;
      } catch {
        // 密钥配置错误统一失败关闭，不回显内容。
      }
    }
    throw this.invalidKeyRing();
  }

  private deriveKey(master: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('gaoq-attendance-data-v1'),
      Buffer.from('sensitive-data-encryption-v1'), 32,
    ));
  }

  private aad(context: AttendanceCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-attendance-data-v1', context.tenantId, context.resourceType, context.resourceId,
    ]));
  }

  private assertContext(context: AttendanceCryptoContext): void {
    if (
      !ID_PATTERN.test(context.tenantId) || !ID_PATTERN.test(context.resourceId) ||
      ![
        'source_fact', 'correction', 'monthly_snapshot',
        'provider_cursor', 'provider_inbox', 'provider_mapping',
      ].includes(context.resourceType)
    ) throw this.invalidCiphertext();
  }

  private decodeKey(value: string): Buffer {
    const decoded = this.decode(value);
    if (decoded.length !== 32) throw this.invalidKeyRing();
    return decoded;
  }

  private decode(value: string): Buffer {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw this.invalidCiphertext();
    return decoded;
  }

  private invalidKeyRing(): AttendanceDomainError {
    return new AttendanceDomainError(
      'ATTENDANCE_DATA_KEY_RING_INVALID', '考勤数据密钥环无效',
    );
  }

  private invalidCiphertext(): AttendanceDomainError {
    return new AttendanceDomainError(
      'ATTENDANCE_DATA_CIPHERTEXT_INVALID', '考勤数据密文或上下文无效',
    );
  }
}
