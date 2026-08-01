import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  AUDIT_GENESIS_HASH,
  AuditIntegrityService,
  type AuditChainPayload,
} from './audit-integrity.service.js';

const KEY = Buffer.alloc(32, 7).toString('base64url');
const EVENT = {
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

describe('AuditIntegrityService', () => {
  it('规范化元数据顺序并生成可验证的租户审计链 HMAC', () => {
    const service = build();
    const normalized = service.normalize(EVENT);
    expect(normalized.metadataCanonical).toBe(
      '{"approved":true,"channel":"feishu","count":1}',
    );
    const chain = payload(service);
    const signed = service.sign(chain);
    expect(signed).toMatchObject({ keyId: 'audit-key-001' });
    expect(signed.eventHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.verify(chain, signed.keyId, signed.eventHash)).toBe(true);
    expect(service.verify({ ...chain, tenantId: 'tenant-002' }, signed.keyId, signed.eventHash))
      .toBe(false);
  });

  it('规范化无资源与无元数据事件，不向链载荷注入 undefined', () => {
    const service = build();
    const normalized = service.normalize({
      tenantId: EVENT.tenantId,
      actorId: EVENT.actorId,
      actorType: EVENT.actorType,
      action: EVENT.action,
      resourceType: EVENT.resourceType,
      riskLevel: EVENT.riskLevel,
      outcome: EVENT.outcome,
      occurredAt: EVENT.occurredAt,
      traceId: EVENT.traceId,
    });
    expect(normalized).not.toHaveProperty('resourceId');
    expect(normalized.metadataCanonical).toBe('{}');
    expect(service.sign({
      ...normalized,
      eventId: '01K00000000000000000000000',
      sequence: 1,
      previousHash: AUDIT_GENESIS_HASH,
    }).eventHash).toHaveLength(43);
  });

  it.each([
    [{ metadata: { accessToken: 'forbidden' } }],
    [{ metadata: { 'unsafe key': 'forbidden' } }],
    [{ metadata: { amount: Number.NaN } }],
    [{ metadata: { nested: { value: 1 } } }],
    [{ metadata: { detail: 'x'.repeat(257) } }],
    [{ tenantId: '$ne' }],
    [{ action: 'UPPER_CASE' }],
    [{
      metadata: Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`field${index}`, index]),
      ),
    }],
  ])('拒绝不安全事件与元数据：%o', (overrides) => {
    expect(() => build().normalize({
      ...EVENT,
      ...overrides,
    } as typeof EVENT)).toThrow('AUDIT_EVENT_INVALID');
  });

  it('允许明确的聚合计数键，但不允许直接身份字段', () => {
    expect(() => build().normalize({
      ...EVENT,
      metadata: { refreshTokensRevoked: 2, mobileCount: 1, accountsDisabled: 3 },
    })).not.toThrow();
    expect(() => build().normalize({
      ...EVENT,
      metadata: { email: 'candidate@example.com' },
    })).toThrow('AUDIT_EVENT_INVALID');
  });

  it.each([
    [null, 'AUDIT_INTEGRITY_KEY_UNAVAILABLE'],
    ['{bad-json', 'AUDIT_INTEGRITY_KEY_INVALID'],
    [JSON.stringify({
      activeKeyId: 'audit-key-001',
      keys: [
        { keyId: 'audit-key-001', keyBase64url: KEY, status: 'active' },
        { keyId: 'audit-key-001', keyBase64url: KEY, status: 'verify_only' },
      ],
    }), 'AUDIT_INTEGRITY_KEY_INVALID'],
    [JSON.stringify({
      activeKeyId: 'audit-key-002',
      keys: [{ keyId: 'audit-key-001', keyBase64url: KEY, status: 'active' }],
    }), 'AUDIT_INTEGRITY_KEY_INVALID'],
    [JSON.stringify({
      activeKeyId: 'audit-key-001',
      keys: [{ keyId: 'audit-key-001', keyBase64url: 'a'.repeat(43), status: 'active' }],
    }), 'AUDIT_INTEGRITY_KEY_INVALID'],
  ])('缺失或非法密钥环失败关闭', (raw, code) => {
    expect(() => build(raw).sign(payload(build()))).toThrow(code);
  });

  it('生产进程初始化立即校验密钥环，非生产延迟到实际签名', () => {
    expect(() => build(null, 'test').onModuleInit()).not.toThrow();
    expect(() => build('{bad-json', 'production').onModuleInit())
      .toThrow('AUDIT_INTEGRITY_KEY_INVALID');
    expect(() => build(keyRing(), 'production').onModuleInit()).not.toThrow();
  });

  it('轮换后新密钥签名且 verify_only 历史密钥继续验签', () => {
    const old = build();
    const chain = payload(old);
    const oldSigned = old.sign(chain);
    const nextKey = Buffer.alloc(32, 8).toString('base64url');
    const rotated = build(JSON.stringify({
      activeKeyId: 'audit-key-002',
      keys: [
        { keyId: 'audit-key-002', keyBase64url: nextKey, status: 'active' },
        { keyId: 'audit-key-001', keyBase64url: KEY, status: 'verify_only' },
      ],
    }));
    expect(rotated.sign(chain).keyId).toBe('audit-key-002');
    expect(rotated.verify(chain, oldSigned.keyId, oldSigned.eventHash)).toBe(true);
    expect(rotated.verify(chain, 'removed-key-001', oldSigned.eventHash)).toBe(false);
  });

  it.each([
    [{ sequence: 0 }],
    [{ sequence: 1.5 }],
    [{ sequence: Number.MAX_SAFE_INTEGER + 1 }],
    [{ eventId: '$invalid' }],
    [{ previousHash: 'invalid' }],
    [{ previousHash: nonCanonicalHash(AUDIT_GENESIS_HASH) }],
    [{ metadataCanonical: '{bad-json' }],
    [{ metadataCanonical: '{"b":2,"a":1}' }],
    [{ metadataCanonical: '{"accessToken":"forbidden"}' }],
    [{ metadataCanonical: `"${'x'.repeat(4_097)}"` }],
    [{ action: 'UPPER_CASE' }],
    [{ unexpected: true }],
  ])('签名与验证拒绝畸形或非规范链载荷：%o', (overrides) => {
    const service = build();
    const invalid = { ...payload(service), ...overrides };
    expect(() => service.sign(invalid)).toThrow('AUDIT_CHAIN_PAYLOAD_INVALID');
    expect(() => service.verify(invalid, 'audit-key-001', 'a'.repeat(43)))
      .toThrow('AUDIT_CHAIN_PAYLOAD_INVALID');
  });

  it('验证拒绝非法 key id、未知密钥、非法哈希和非规范 Base64URL', () => {
    const service = build();
    const chain = payload(service);
    const signed = service.sign(chain);
    expect(service.verify(chain, 'short', signed.eventHash)).toBe(false);
    expect(service.verify(chain, 'removed-key-001', signed.eventHash)).toBe(false);
    expect(service.verify(chain, signed.keyId, 'invalid')).toBe(false);
    expect(service.verify(
      chain,
      signed.keyId,
      nonCanonicalHash(signed.eventHash),
    )).toBe(false);
  });
});

function build(
  raw: string | null = keyRing(),
  environment = 'test',
): AuditIntegrityService {
  return new AuditIntegrityService({
    get: (key: string) => key === 'NODE_ENV' ? environment : (raw ?? undefined),
  } as unknown as ConfigService<AppEnvironment, true>);
}

function keyRing(): string {
  return JSON.stringify({
    activeKeyId: 'audit-key-001',
    keys: [{ keyId: 'audit-key-001', keyBase64url: KEY, status: 'active' }],
  });
}

function payload(service: AuditIntegrityService): AuditChainPayload {
  return {
    ...service.normalize(EVENT),
    eventId: '01K00000000000000000000000',
    sequence: 1,
    previousHash: AUDIT_GENESIS_HASH,
  };
}

function nonCanonicalHash(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = value.at(-1);
  if (last === undefined) throw new Error('测试哈希不能为空');
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 4 !== 0) throw new Error('输入必须是规范 SHA-256 Base64URL');
  return `${value.slice(0, -1)}${alphabet[index + 1]}`;
}
