import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { AppEnvironment } from '../../config/environment.js';

const KEY = /^[A-Za-z0-9_-]{43}$/u;

export interface ProtectedMarketingContact {
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

/** 营销线索联系人加密与盲索引；两个密钥域禁止复用。 */
@Injectable()
export class MarketingLeadCryptoService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  protect(tenantId: string, leadId: string, contact: string): ProtectedMarketingContact {
    const key = this.key('MARKETING_LEAD_ENCRYPTION_KEY_BASE64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['gaoq-marketing-contact-v1', tenantId, leadId])));
    try {
      const ciphertext = Buffer.concat([cipher.update(contact, 'utf8'), cipher.final()]);
      return Object.freeze({
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      });
    } finally {
      key.fill(0);
    }
  }

  blindIndex(tenantId: string, contact: string): string {
    const key = this.key('MARKETING_LEAD_BLIND_INDEX_KEY_BASE64');
    try {
      return createHmac('sha256', key)
        .update(JSON.stringify(['gaoq-marketing-contact-blind-index-v1', tenantId, contact.toLowerCase()]))
        .digest('base64url');
    } finally {
      key.fill(0);
    }
  }

  unprotect(
    tenantId: string,
    leadId: string,
    value: ProtectedMarketingContact,
  ): string {
    const key = this.key('MARKETING_LEAD_ENCRYPTION_KEY_BASE64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
      decipher.setAAD(Buffer.from(JSON.stringify(['gaoq-marketing-contact-v1', tenantId, leadId])));
      decipher.setAuthTag(Buffer.from(value.authTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException({
        code: 'MARKETING_LEAD_DECRYPT_FAILED',
        message: '线索联系方式暂时不可读取',
      });
    } finally {
      key.fill(0);
    }
  }

  private key(
    name: 'MARKETING_LEAD_ENCRYPTION_KEY_BASE64' | 'MARKETING_LEAD_BLIND_INDEX_KEY_BASE64',
  ): Buffer {
    const value = this.config.get(name, { infer: true });
    if (value === undefined || !KEY.test(value)) throw new ServiceUnavailableException({
      code: 'MARKETING_LEAD_PROTECTION_UNAVAILABLE',
      message: '预约服务的数据保护配置不可用',
    });
    return Buffer.from(value, 'base64url');
  }
}
