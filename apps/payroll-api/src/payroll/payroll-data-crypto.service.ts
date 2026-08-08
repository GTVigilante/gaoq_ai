import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';

import type { AppEnvironment } from '../config/environment.js';

const keySchema = z.object({
  keyId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/),
  keyBase64: z.string().min(43).max(44),
  status: z.enum(['active', 'decrypt_only']),
}).strict();
const keyRingSchema = z.array(keySchema).min(1).max(10);

interface KeyEntry {
  readonly keyId: string;
  readonly key: Buffer;
  readonly status: 'active' | 'decrypt_only';
}

export interface PayrollCiphertext {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextDigest: string;
}

export interface PayrollCryptoContext {
  readonly tenantId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly version: number;
}

/** 薪酬 L4 数据 AES-256-GCM 加密与员工 HMAC 盲索引服务。 */
@Injectable()
export class PayrollDataCryptoService {
  private dataKeys?: readonly KeyEntry[];
  private blindIndexKeys?: readonly KeyEntry[];

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect<T>(context: PayrollCryptoContext, value: T): PayrollCiphertext {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const key = this.activeDataKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, iv);
    cipher.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({
      keyId: key.keyId,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
      plaintextDigest: createHash('sha256').update(plaintext).digest('hex'),
    });
  }

  unprotect<T>(context: PayrollCryptoContext, protectedValue: PayrollCiphertext): T {
    const key = this.dataKey(protectedValue.keyId);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key.key,
        Buffer.from(protectedValue.iv, 'base64url'),
      );
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(Buffer.from(protectedValue.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(protectedValue.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const digest = createHash('sha256').update(plaintext).digest('hex');
      if (digest !== protectedValue.plaintextDigest) throw new Error('digest mismatch');
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      throw new Error('薪酬密文认证失败');
    }
  }

  /** 生成租户和用途绑定的员工盲索引，禁止跨租户关联。 */
  employeeBlindIndex(tenantId: string, employeeId: string): string {
    if (tenantId.length === 0 || employeeId.length === 0) {
      throw new Error('盲索引上下文不能为空');
    }
    const key = this.activeBlindIndexKey();
    return createHmac('sha256', key.key)
      .update(`payroll-employee:v1:${tenantId}:${employeeId}`, 'utf8')
      .digest('base64url');
  }

  private aad(context: PayrollCryptoContext): Buffer {
    if (
      context.tenantId.length === 0 ||
      context.resourceType.length === 0 ||
      context.resourceId.length === 0 ||
      !Number.isInteger(context.version) ||
      context.version < 1
    ) throw new Error('薪酬加密上下文非法');
    return Buffer.from(JSON.stringify({
      tenantId: context.tenantId,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
      version: context.version,
    }), 'utf8');
  }

  private activeDataKey(): KeyEntry {
    const key = this.getDataKeys().find((candidate) => candidate.status === 'active');
    if (key === undefined) throw this.unavailable('薪酬数据缺少 active 加密密钥');
    return key;
  }

  private activeBlindIndexKey(): KeyEntry {
    const key = this.getBlindIndexKeys().find((candidate) => candidate.status === 'active');
    if (key === undefined) throw this.unavailable('薪酬盲索引缺少 active 密钥');
    return key;
  }

  private dataKey(keyId: string): KeyEntry {
    const key = this.getDataKeys().find((candidate) => candidate.keyId === keyId);
    if (key === undefined) throw this.unavailable('薪酬密文引用未知密钥');
    return key;
  }

  private getDataKeys(): readonly KeyEntry[] {
    this.dataKeys ??= this.parseKeyRing('PAYROLL_DATA_ENCRYPTION_KEYS');
    this.assertKeyDomainsSeparated();
    return this.dataKeys;
  }

  private getBlindIndexKeys(): readonly KeyEntry[] {
    this.blindIndexKeys ??= this.parseKeyRing('PAYROLL_BLIND_INDEX_KEYS');
    this.assertKeyDomainsSeparated();
    return this.blindIndexKeys;
  }

  private parseKeyRing(
    name: 'PAYROLL_DATA_ENCRYPTION_KEYS' | 'PAYROLL_BLIND_INDEX_KEYS',
  ): readonly KeyEntry[] {
    const raw = this.config.get(name, { infer: true });
    if (raw === undefined) throw this.unavailable(`${name} 未配置`);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw this.unavailable(`${name} 不是合法 JSON`);
    }
    const parsed = keyRingSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.filter((key) => key.status === 'active').length !== 1) {
      throw this.unavailable(`${name} 必须且只能包含一个 active 密钥`);
    }
    const ids = new Set<string>();
    return Object.freeze(parsed.data.map((entry) => {
      if (ids.has(entry.keyId)) throw this.unavailable(`${name} keyId 重复`);
      ids.add(entry.keyId);
      const key = Buffer.from(entry.keyBase64, 'base64');
      if (key.length !== 32) throw this.unavailable(`${name} 必须使用 256 位密钥`);
      return Object.freeze({ keyId: entry.keyId, key, status: entry.status });
    }));
  }

  private assertKeyDomainsSeparated(): void {
    if (this.dataKeys === undefined || this.blindIndexKeys === undefined) return;
    const dataValues = new Set(this.dataKeys.map((entry) => entry.key.toString('base64')));
    if (this.blindIndexKeys.some((entry) => dataValues.has(entry.key.toString('base64')))) {
      throw this.unavailable('薪酬数据加密和盲索引密钥禁止复用');
    }
  }

  private unavailable(message: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PAYROLL_CRYPTO_UNAVAILABLE',
      message,
    });
  }
}
