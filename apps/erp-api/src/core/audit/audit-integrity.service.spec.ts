import { randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  AUDIT_GENESIS_HASH,
  AuditIntegrityService,
  type AuditChainPayload,
} from './audit-integrity.service.js';

const event = {
  tenantId: 'tenant-001',
  actorId: 'employee-001',
  actorType: 'user' as const,
  action: 'employee.profile.update',
  resourceType: 'employee.profile',
  resourceId: 'employee-001',
  riskLevel: 'R2' as const,
  outcome: 'success' as const,
  occurredAt: '2026-07-21T05:00:00.000Z',
  traceId: 'trace-001',
  metadata: { count: 1, channel: 'feishu', approved: true },
};

function build() {
  const key = randomBytes(32).toString('base64url');
  const raw = JSON.stringify({
    activeKeyId: 'audit-key-001',
    keys: [{ keyId: 'audit-key-001', keyBase64url: key, status: 'active' }],
  });
  return new AuditIntegrityService({
    get: (key: string) => key === 'NODE_ENV' ? 'test' : raw,
  } as unknown as ConfigService<AppEnvironment, true>);
}

describe('AuditIntegrityService', () => {
  it('规范化元数据顺序并生成可验证的租户审计链 HMAC', () => {
    const service = build();
    const normalized = service.normalize(event);
    expect(normalized.metadataCanonical).toBe('{"approved":true,"channel":"feishu","count":1}');
    const payload: AuditChainPayload = {
      ...normalized,
      eventId: '01K00000000000000000000000',
      sequence: 1,
      previousHash: AUDIT_GENESIS_HASH,
    };
    const signed = service.sign(payload);
    expect(signed.eventHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.verify(payload, signed.keyId, signed.eventHash)).toBe(true);
    expect(service.verify({ ...payload, tenantId: 'tenant-002' }, signed.keyId, signed.eventHash))
      .toBe(false);
  });

  it('拒绝敏感元数据键、过量字段和不安全事件标识', () => {
    const service = build();
    expect(() => service.normalize({ ...event, metadata: { accessToken: 'forbidden' } }))
      .toThrow('AUDIT_EVENT_INVALID');
    expect(() => service.normalize({ ...event, tenantId: '$ne' })).toThrow('AUDIT_EVENT_INVALID');
    expect(() => service.normalize({
      ...event,
      metadata: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field${index}`, index])),
    })).toThrow('AUDIT_EVENT_INVALID');
    expect(() => service.normalize({
      ...event,
      metadata: { refreshTokensRevoked: 2, mobileCount: 1 },
    })).not.toThrow();
  });

  it('拒绝缺失、非法和已移除的完整性密钥', () => {
    const missing = new AuditIntegrityService({
      get: () => undefined,
    } as unknown as ConfigService<AppEnvironment, true>);
    const payload: AuditChainPayload = {
      ...build().normalize(event), eventId: '01K00000000000000000000000',
      sequence: 1, previousHash: AUDIT_GENESIS_HASH,
    };
    expect(() => missing.sign(payload)).toThrow('AUDIT_INTEGRITY_KEY_UNAVAILABLE');
    expect(build().verify(payload, 'removed-key-001', 'a'.repeat(43))).toBe(false);
  });

  it('生产进程在模块初始化时立即校验密钥环', () => {
    const service = new AuditIntegrityService({
      get: (key: string) => key === 'NODE_ENV' ? 'production' : 'invalid-ring',
    } as unknown as ConfigService<AppEnvironment, true>);
    expect(() => service.onModuleInit()).toThrow('AUDIT_INTEGRITY_KEY_INVALID');
  });
});
