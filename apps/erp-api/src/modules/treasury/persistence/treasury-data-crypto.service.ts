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

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ACCOUNT_PATTERN = /^[0-9]{8,32}$/;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

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
  ) context.addIssue({ code: 'custom', message: '资金数据加密密钥环状态非法' });
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
  ) context.addIssue({ code: 'custom', message: '资金账号盲索引密钥环状态非法' });
});

export type TreasuryCryptoResourceType =
  | 'bank_account'
  | 'payment_instruction'
  | 'bank_file'
  | 'bank_return';

export interface TreasuryCryptoContext {
  readonly tenantId: string;
  readonly resourceType: TreasuryCryptoResourceType;
  readonly resourceId: string;
  readonly version: number;
}

export interface ProtectedTreasuryData {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export class TreasuryDataCryptoError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TreasuryDataCryptoError';
  }
}

/** 资金 L4 数据加密与银行账号盲索引；密钥域相互独立且支持无停机轮换。 */
@Injectable()
export class TreasuryDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: TreasuryCryptoContext, value: unknown): ProtectedTreasuryData {
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
      if (error instanceof TreasuryDataCryptoError) throw error;
      throw this.invalidCiphertext();
    } finally {
      plaintext?.fill(0);
      master.fill(0);
      key.fill(0);
    }
  }

  unprotect(context: TreasuryCryptoContext, value: ProtectedTreasuryData): unknown {
    this.assertContext(context);
    if (
      !KEY_PATTERN.test(value.keyId) || !BASE64URL_PATTERN.test(value.iv) ||
      !BASE64URL_PATTERN.test(value.ciphertext) || !BASE64URL_PATTERN.test(value.authTag)
    ) throw this.invalidCiphertext();
    const configured = this.loadEncryptionRing().keys.find((key) => key.keyId === value.keyId);
    if (configured === undefined) throw new TreasuryDataCryptoError(
      'TREASURY_DATA_KEY_UNAVAILABLE', '资金数据解密密钥不可用',
    );
    const master = this.decodeKey(configured.keyBase64url);
    const key = this.deriveKey(master);
    let plaintext: Buffer | undefined;
    try {
      const iv = this.decode(value.iv);
      const ciphertext = this.decode(value.ciphertext);
      const authTag = this.decode(value.authTag);
      if (
        iv.length !== 12 || authTag.length !== 16 ||
        ciphertext.length > MAX_PLAINTEXT_BYTES + 16
      ) throw this.invalidCiphertext();
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(authTag);
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

  /** 返回当前与只读旧密钥的全部盲索引，以支持轮换期无明文精确匹配。 */
  accountFingerprints(tenantId: string, account: string): readonly string[] {
    this.assertIdentifier(tenantId);
    if (!ACCOUNT_PATTERN.test(account)) throw this.invalidCiphertext();
    const ring = this.loadBlindIndexRing();
    return Object.freeze(ring.keys.map((configured) => {
      const key = this.decodeKey(configured.keyBase64url);
      try {
        return `${configured.keyId}.${createHmac('sha256', key).update(JSON.stringify([
          'gaoq-treasury-bank-account-v1', tenantId, account,
        ])).digest('base64url')}`;
      } finally {
        key.fill(0);
      }
    }));
  }

  private loadEncryptionRing(): z.infer<typeof encryptionRingSchema> {
    return this.loadIndependentRings().encryption;
  }

  private loadBlindIndexRing(): z.infer<typeof blindIndexRingSchema> {
    return this.loadIndependentRings().blindIndex;
  }

  private loadIndependentRings(): {
    readonly encryption: z.infer<typeof encryptionRingSchema>;
    readonly blindIndex: z.infer<typeof blindIndexRingSchema>;
  } {
    const encryption = this.parseRing(
      this.config.get('TREASURY_DATA_ENCRYPTION_KEYS', { infer: true }),
      encryptionRingSchema,
    );
    const blindIndex = this.parseRing(
      this.config.get('TREASURY_BLIND_INDEX_KEYS', { infer: true }),
      blindIndexRingSchema,
    );
    const encryptionMaterial = new Set(encryption.keys.map((key) => key.keyBase64url));
    if (blindIndex.keys.some((key) => encryptionMaterial.has(key.keyBase64url))) {
      throw this.invalidKeyRing();
    }
    return Object.freeze({ encryption, blindIndex });
  }

  private parseRing<T>(raw: string | undefined, schema: z.ZodType<T>): T {
    if (raw !== undefined) {
      try {
        const parsed = schema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) return parsed.data;
      } catch {
        // 密钥配置错误统一失败关闭，不回显内容。
      }
    }
    throw this.invalidKeyRing();
  }

  private deriveKey(master: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('gaoq-treasury-data-v1'),
      Buffer.from('l4-data-encryption-v1'), 32,
    ));
  }

  private aad(context: TreasuryCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-treasury-data-v1', context.tenantId, context.resourceType,
      context.resourceId, context.version,
    ]));
  }

  private assertContext(context: TreasuryCryptoContext): void {
    if (
      !ID_PATTERN.test(context.tenantId) || !ID_PATTERN.test(context.resourceId) ||
      !Number.isSafeInteger(context.version) || context.version < 1 ||
      !['bank_account', 'payment_instruction', 'bank_file', 'bank_return']
        .includes(context.resourceType)
    ) throw this.invalidCiphertext();
  }

  private assertIdentifier(value: string): void {
    if (!ID_PATTERN.test(value)) throw this.invalidCiphertext();
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

  private invalidKeyRing(): TreasuryDataCryptoError {
    return new TreasuryDataCryptoError(
      'TREASURY_DATA_KEY_RING_INVALID', '资金数据密钥环无效',
    );
  }

  private invalidCiphertext(): TreasuryDataCryptoError {
    return new TreasuryDataCryptoError(
      'TREASURY_DATA_CIPHERTEXT_INVALID', '资金数据密文或上下文无效',
    );
  }
}
