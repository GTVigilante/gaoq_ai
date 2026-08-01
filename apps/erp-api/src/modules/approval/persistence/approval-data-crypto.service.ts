import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import type { ApprovalFormData } from '../domain/condition.js';
import { ApprovalDomainError } from '../domain/approval.errors.js';

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const keyRingSchema = z.object({
  activeKeyId: z.string().regex(ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(ID_PATTERN),
    keyBase64url: z.string().regex(BASE64URL_256_PATTERN),
    status: z.enum(['active', 'decrypt_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '审批加密 keyId 不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须指向唯一 active 密钥' });
  }
});

export interface ApprovalDataCryptoContext {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly definitionHash: string;
}

export interface ProtectedApprovalFormData {
  readonly formDataKeyId: string;
  readonly formDataIv: string;
  readonly formDataCiphertext: string;
  readonly formDataAuthTag: string;
}

interface ApprovalKeyRing {
  readonly activeKeyId: string;
  readonly keys: readonly {
    readonly keyId: string;
    readonly keyBase64url: string;
    readonly status: 'active' | 'decrypt_only';
  }[];
}

/** 审批表单静态加密：Mongo 只保存 AES-256-GCM 密文，AAD 绑定租户、实例和模板摘要。 */
@Injectable()
export class ApprovalDataCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(
    context: ApprovalDataCryptoContext,
    formData: ApprovalFormData,
  ): ProtectedApprovalFormData {
    this.assertContext(context);
    const ring = this.loadRing();
    const key = this.keyById(ring, ring.activeKeyId);
    const masterKey = this.decodeKey(key.keyBase64url);
    const encryptionKey = this.deriveKey(masterKey);
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const plaintext = Buffer.from(JSON.stringify(formData), 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      cipher.setAAD(this.aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        formDataKeyId: key.keyId,
        formDataIv: iv.toString('base64url'),
        formDataCiphertext: ciphertext.toString('base64url'),
        formDataAuthTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      plaintext.fill(0);
      masterKey.fill(0);
      encryptionKey.fill(0);
    }
  }

  unprotect(
    context: ApprovalDataCryptoContext,
    protectedData: ProtectedApprovalFormData,
  ): unknown {
    this.assertContext(context);
    if (
      !ID_PATTERN.test(protectedData.formDataKeyId) ||
      !BASE64URL_PATTERN.test(protectedData.formDataIv) ||
      !BASE64URL_PATTERN.test(protectedData.formDataCiphertext) ||
      !BASE64URL_PATTERN.test(protectedData.formDataAuthTag)
    ) throw this.invalidPayload();
    const iv = Buffer.from(protectedData.formDataIv, 'base64url');
    const ciphertext = Buffer.from(protectedData.formDataCiphertext, 'base64url');
    const authTag = Buffer.from(protectedData.formDataAuthTag, 'base64url');
    if (iv.length !== AES_GCM_IV_BYTES || authTag.length !== AES_GCM_TAG_BYTES) {
      throw this.invalidPayload();
    }
    const ring = this.loadRing();
    const key = this.keyById(ring, protectedData.formDataKeyId);
    const masterKey = this.decodeKey(key.keyBase64url);
    const encryptionKey = this.deriveKey(masterKey);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof ApprovalDomainError) throw error;
      throw this.invalidPayload();
    } finally {
      plaintext?.fill(0);
      masterKey.fill(0);
      encryptionKey.fill(0);
    }
  }

  private loadRing(): ApprovalKeyRing {
    const raw = this.config.get('APPROVAL_DATA_ENCRYPTION_KEYS', { infer: true });
    if (raw === undefined) throw this.invalidKeyRing();
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

  private keyById(ring: ApprovalKeyRing, keyId: string): ApprovalKeyRing['keys'][number] {
    const key = ring.keys.find((candidate) => candidate.keyId === keyId);
    if (key === undefined) {
      throw new ApprovalDomainError('APPROVAL_DATA_KEY_UNAVAILABLE', '审批数据解密密钥不可用');
    }
    return key;
  }

  private decodeKey(encoded: string): Buffer {
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw this.invalidKeyRing();
    return key;
  }

  private deriveKey(masterKey: Buffer): Buffer {
    return Buffer.from(hkdfSync(
      'sha256', masterKey, Buffer.from('gaoq-approval-data-v1', 'utf8'),
      Buffer.from('form-data-encryption-v1', 'utf8'), 32,
    ));
  }

  private aad(context: ApprovalDataCryptoContext): Buffer {
    return Buffer.from(JSON.stringify([
      'gaoq-approval-data-v1', context.tenantId, context.instanceId, context.definitionHash,
    ]), 'utf8');
  }

  private assertContext(context: ApprovalDataCryptoContext): void {
    if (
      !ID_PATTERN.test(context.tenantId) || !ID_PATTERN.test(context.instanceId) ||
      !BASE64URL_256_PATTERN.test(context.definitionHash)
    ) throw this.invalidPayload();
  }

  private invalidKeyRing(): ApprovalDomainError {
    return new ApprovalDomainError('APPROVAL_DATA_KEY_RING_INVALID', '审批数据加密密钥环无效');
  }

  private invalidPayload(): ApprovalDomainError {
    return new ApprovalDomainError('APPROVAL_DATA_CIPHERTEXT_INVALID', '审批数据密文无效');
  }
}
