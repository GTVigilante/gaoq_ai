import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

const keyRingSchema = z.object({
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
  ) context.addIssue({ code: 'custom', message: '薪酬加密密钥环状态非法' });
});

export type PayrollCryptoResourceType =
  | 'compensation_profile'
  | 'input_snapshot'
  | 'calculation_line'
  | 'tax_filing'
  | 'shadow_cycle'
  | 'shadow_difference';

export interface PayrollCryptoContext {
  readonly tenantId: string;
  readonly resourceType: PayrollCryptoResourceType;
  readonly resourceId: string;
  readonly version: number;
}

export interface ProtectedPayrollData {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

/** 薪酬 L4 数据独立 AES-256-GCM 密钥域；AAD 同时绑定资源版本。 */
@Injectable()
export class PayrollDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(context: PayrollCryptoContext, value: unknown): ProtectedPayrollData {
    this.assertContext(context);
    const ring = this.loadRing();
    const configured = ring.keys.find((key) => key.keyId === ring.activeKeyId);
    if (configured === undefined) throw new Error('PAYROLL_DATA_KEY_RING_INVALID');
    const master = this.decodeKey(configured.keyBase64url);
    const key = this.deriveKey(master);
    const iv = randomBytes(12);
    let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('PAYROLL_DATA_TOO_LARGE');
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(this.aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        keyId: configured.keyId,
        iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PAYROLL_DATA_TOO_LARGE') throw error;
      throw new Error('PAYROLL_DATA_CIPHERTEXT_INVALID', { cause: error });
    } finally {
      plaintext?.fill(0); master.fill(0); key.fill(0);
    }
  }

  unprotect(context: PayrollCryptoContext, value: ProtectedPayrollData): unknown {
    this.assertContext(context);
    if (
      !KEY_PATTERN.test(value.keyId) || !BASE64URL_PATTERN.test(value.iv) ||
      !BASE64URL_PATTERN.test(value.ciphertext) || !BASE64URL_PATTERN.test(value.authTag)
    ) throw new Error('PAYROLL_DATA_CIPHERTEXT_INVALID');
    const configured = this.loadRing().keys.find((key) => key.keyId === value.keyId);
    if (configured === undefined) throw new Error('PAYROLL_DATA_KEY_UNAVAILABLE');
    const master = this.decodeKey(configured.keyBase64url);
    const key = this.deriveKey(master);
    let plaintext: Buffer | undefined;
    try {
      const iv = this.decode(value.iv);
      const ciphertext = this.decode(value.ciphertext);
      const authTag = this.decode(value.authTag);
      if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16) {
        throw new Error('PAYROLL_DATA_CIPHERTEXT_INVALID');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error('PAYROLL_DATA_CIPHERTEXT_INVALID', { cause: error });
    } finally {
      plaintext?.fill(0); master.fill(0); key.fill(0);
    }
  }

  private loadRing(): z.infer<typeof keyRingSchema> {
    const raw = this.config.get('PAYROLL_DATA_ENCRYPTION_KEYS', { infer: true });
    if (raw !== undefined) {
      try {
        const parsed = keyRingSchema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) return parsed.data;
      } catch {
        // 配置错误统一失败关闭且不回显内容。
      }
    }
    throw new Error('PAYROLL_DATA_KEY_RING_INVALID');
  }

  private assertContext(context: PayrollCryptoContext): void {
    if (
      !ID_PATTERN.test(context.tenantId) || !ID_PATTERN.test(context.resourceId) ||
      !Number.isSafeInteger(context.version) || context.version < 1 ||
      ![
        'compensation_profile', 'input_snapshot', 'calculation_line', 'tax_filing',
        'shadow_cycle', 'shadow_difference',
      ]
        .includes(context.resourceType)
    ) throw new Error('PAYROLL_DATA_CONTEXT_INVALID');
  }

  private deriveKey(master: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('gaoq-payroll-data-v1'),
      Buffer.from('l4-data-encryption-v1'), 32,
    ));
  }

  private aad(context: PayrollCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-payroll-data-v1', context.tenantId, context.resourceType,
      context.resourceId, context.version,
    ]));
  }

  private decodeKey(value: string): Buffer {
    const decoded = this.decode(value);
    if (decoded.length !== 32) throw new Error('PAYROLL_DATA_KEY_RING_INVALID');
    return decoded;
  }

  private decode(value: string): Buffer {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('PAYROLL_DATA_CIPHERTEXT_INVALID');
    return decoded;
  }
}
