import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import { OrgDomainError } from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]{43}$/;
const MONTH_DAY_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

const keyRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_ID_PATTERN),
    keyBase64url: z.string().regex(KEY_PATTERN),
    status: z.enum(['active', 'lookup_only']),
  }).strict()).min(1).max(5),
}).strict().superRefine((ring, context) => {
  const active = ring.keys.filter((key) => key.status === 'active');
  if (
    active.length !== 1 ||
    active[0]?.keyId !== ring.activeKeyId ||
    new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length
  ) {
    context.addIssue({ code: 'custom', message: '自然人生日盲索引密钥环状态非法' });
  }
});

/**
 * Person 生日月日专用盲索引。
 * 不可复用招聘、考勤或资金密钥；持久层和日志均不得保存明文月日。
 */
@Injectable()
export class OrgPersonBirthdayBlindIndexService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  fingerprints(tenantId: string, monthDay: string): readonly string[] {
    this.assertTenant(tenantId);
    this.assertMonthDay(monthDay);
    return this.fingerprintsFromRing(this.loadRing(), tenantId, monthDay);
  }

  private fingerprintsFromRing(
    ring: z.infer<typeof keyRingSchema>,
    tenantId: string,
    monthDay: string,
  ): readonly string[] {
    return Object.freeze(ring.keys.map((configured) => {
      const key = this.decodeKey(configured.keyBase64url);
      try {
        return `${configured.keyId}.${createHmac('sha256', key).update(JSON.stringify([
          'gaoq-org-person-birthday-month-day-v1',
          tenantId,
          monthDay,
        ])).digest('base64url')}`;
      } finally {
        key.fill(0);
      }
    }));
  }

  activeFingerprint(tenantId: string, monthDay: string): string {
    this.assertTenant(tenantId);
    this.assertMonthDay(monthDay);
    const ring = this.loadRing();
    const fingerprints = this.fingerprintsFromRing(ring, tenantId, monthDay);
    const index = ring.keys.findIndex((key) => key.keyId === ring.activeKeyId);
    const value = fingerprints[index];
    if (value === undefined) throw this.invalidKeyRing();
    return value;
  }

  /**
   * 仅在受控应用服务内将盲索引解析为年内月日。
   * 候选空间固定为闰年 366 天，不向仓储、事件、审计或 MCP 暴露索引。
   */
  resolveMonthDay(tenantId: string, fingerprints: readonly string[]): string | null {
    this.assertTenant(tenantId);
    if (
      fingerprints.length === 0 ||
      fingerprints.length > 5 ||
      fingerprints.some((value) => !FINGERPRINT_PATTERN.test(value))
    ) return null;
    const available = new Set(fingerprints);
    const ring = this.loadRing();
    for (let month = 1; month <= 12; month += 1) {
      const days = new Date(Date.UTC(2000, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        const monthDay = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (
          this.fingerprintsFromRing(ring, tenantId, monthDay)
            .some((value) => available.has(value))
        ) {
          return monthDay;
        }
      }
    }
    return null;
  }

  private loadRing(): z.infer<typeof keyRingSchema> {
    const raw = this.config.get('ORG_PERSON_BIRTHDAY_BLIND_INDEX_KEYS', { infer: true });
    if (raw !== undefined) {
      try {
        const result = keyRingSchema.safeParse(JSON.parse(raw) as unknown);
        if (result.success) return result.data;
      } catch {
        // 配置错误统一失败关闭，不回显密钥内容。
      }
    }
    throw this.invalidKeyRing();
  }

  private assertTenant(tenantId: string): void {
    if (!ID_PATTERN.test(tenantId)) {
      throw new OrgDomainError('PERSON_BIRTHDAY_CONTEXT_INVALID', '生日盲索引租户上下文非法');
    }
  }

  private assertMonthDay(monthDay: string): void {
    if (!MONTH_DAY_PATTERN.test(monthDay)) {
      throw new OrgDomainError('PERSON_BIRTHDAY_MONTH_DAY_INVALID', '生日月日必须为 MM-DD');
    }
    const date = new Date(`2000-${monthDay}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(5, 10) !== monthDay) {
      throw new OrgDomainError('PERSON_BIRTHDAY_MONTH_DAY_INVALID', '生日月日不是合法日期');
    }
  }

  private decodeKey(value: string): Buffer {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
      throw this.invalidKeyRing();
    }
    return decoded;
  }

  private invalidKeyRing(): OrgDomainError {
    return new OrgDomainError(
      'PERSON_BIRTHDAY_KEY_RING_INVALID',
      '自然人生日盲索引密钥环无效',
    );
  }
}
