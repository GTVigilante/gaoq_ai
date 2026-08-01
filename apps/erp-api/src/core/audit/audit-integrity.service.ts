import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditEvent } from './audit.types.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9._:-]{2,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FORBIDDEN_METADATA_KEY = /(?:password|passwd|secret|token|authorization|cookie|mobile|phone|email|bank|account|idcard|identitycard|privatekey|ciphertext)/i;
export const AUDIT_GENESIS_HASH = '0'.repeat(43);
const CHAIN_PAYLOAD_KEYS = new Set([
  'tenantId',
  'actorId',
  'actorType',
  'action',
  'resourceType',
  'resourceId',
  'riskLevel',
  'outcome',
  'occurredAt',
  'traceId',
  'metadataCanonical',
  'eventId',
  'sequence',
  'previousHash',
]);

const metadataValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
]);

const auditEventSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  actorId: z.string().regex(ID_PATTERN),
  actorType: z.enum(['user', 'service', 'mcp_client', 'system_job']),
  action: z.string().regex(ACTION_PATTERN),
  resourceType: z.string().regex(ACTION_PATTERN),
  resourceId: z.string().regex(ID_PATTERN).optional(),
  riskLevel: z.enum(['R0', 'R1', 'R2', 'R3']),
  outcome: z.enum(['success', 'denied', 'failure']),
  occurredAt: z.string().datetime({ offset: true }),
  traceId: z.string().regex(ID_PATTERN),
  metadata: z.record(z.string().min(1).max(64), metadataValueSchema).optional(),
}).strict().superRefine((event, context) => {
  const keys = Object.keys(event.metadata ?? {});
  if (keys.length > 20) {
    context.addIssue({ code: 'custom', path: ['metadata'], message: '审计元数据字段过多' });
  }
  for (const key of keys) {
    const aggregateOnly = /(?:count|revoked|disabled)$/i.test(key);
    if (
      !/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(key) ||
      (FORBIDDEN_METADATA_KEY.test(key) && !aggregateOnly)
    ) {
      context.addIssue({ code: 'custom', path: ['metadata', key], message: '审计元数据键不安全' });
    }
  }
});

const keyRingSchema = z.object({
  activeKeyId: z.string().regex(KEY_ID_PATTERN),
  keys: z.array(z.object({
    keyId: z.string().regex(KEY_ID_PATTERN),
    keyBase64url: z.string().regex(HASH_PATTERN),
    status: z.enum(['active', 'verify_only']),
  }).strict()).min(1).max(8),
}).strict().superRefine((ring, context) => {
  if (new Set(ring.keys.map((key) => key.keyId)).size !== ring.keys.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: '审计密钥标识不得重复' });
  }
  const active = ring.keys.filter((key) => key.status === 'active');
  if (active.length !== 1 || active[0]?.keyId !== ring.activeKeyId) {
    context.addIssue({ code: 'custom', path: ['activeKeyId'], message: '必须精确指向唯一 active 密钥' });
  }
});

export interface NormalizedAuditEvent extends Omit<AuditEvent, 'metadata'> {
  readonly metadataCanonical: string;
}

export interface AuditChainPayload extends NormalizedAuditEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly previousHash: string;
}

interface AuditIntegrityKeyRing {
  readonly activeKeyId: string;
  readonly keys: readonly {
    readonly keyId: string;
    readonly keyBase64url: string;
    readonly status: 'active' | 'verify_only';
  }[];
}

/** 审计事件规范化与 HMAC 链服务；密钥只从运行时 Secret 注入读取。 */
@Injectable()
export class AuditIntegrityService implements OnModuleInit {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') this.loadKeyRing();
  }

  normalize(untrusted: AuditEvent): NormalizedAuditEvent {
    const parsed = auditEventSchema.safeParse(untrusted);
    if (!parsed.success) throw new Error('AUDIT_EVENT_INVALID');
    return Object.freeze({
      tenantId: parsed.data.tenantId,
      actorId: parsed.data.actorId,
      actorType: parsed.data.actorType,
      action: parsed.data.action,
      resourceType: parsed.data.resourceType,
      ...(parsed.data.resourceId === undefined ? {} : { resourceId: parsed.data.resourceId }),
      riskLevel: parsed.data.riskLevel,
      outcome: parsed.data.outcome,
      occurredAt: parsed.data.occurredAt,
      traceId: parsed.data.traceId,
      metadataCanonical: stableJson(parsed.data.metadata ?? {}),
    });
  }

  sign(payload: AuditChainPayload): { readonly keyId: string; readonly eventHash: string } {
    this.assertChainPayload(payload);
    const ring = this.loadKeyRing();
    const key = ring.keys.find((candidate) => candidate.keyId === ring.activeKeyId);
    if (key === undefined) throw new Error('AUDIT_INTEGRITY_KEY_INVALID');
    return Object.freeze({ keyId: key.keyId, eventHash: this.hmac(key.keyBase64url, payload) });
  }

  verify(
    payload: AuditChainPayload,
    keyId: string,
    expectedHash: string,
  ): boolean {
    this.assertChainPayload(payload);
    if (!KEY_ID_PATTERN.test(keyId) || !HASH_PATTERN.test(expectedHash)) return false;
    const key = this.loadKeyRing().keys.find((candidate) => candidate.keyId === keyId);
    if (key === undefined) return false;
    const actual = Buffer.from(this.hmac(key.keyBase64url, payload), 'base64url');
    const expected = decodeCanonicalHash(expectedHash);
    return expected !== null && timingSafeEqual(actual, expected);
  }

  private loadKeyRing(): AuditIntegrityKeyRing {
    const raw = this.config.get('AUDIT_INTEGRITY_KEYS', { infer: true });
    if (raw === undefined) throw new Error('AUDIT_INTEGRITY_KEY_UNAVAILABLE');
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('AUDIT_INTEGRITY_KEY_INVALID');
    }
    const parsed = keyRingSchema.safeParse(decoded);
    if (!parsed.success) throw new Error('AUDIT_INTEGRITY_KEY_INVALID');
    return parsed.data;
  }

  private hmac(encodedKey: string, payload: AuditChainPayload): string {
    const key = Buffer.from(encodedKey, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encodedKey) {
      key.fill(0);
      throw new Error('AUDIT_INTEGRITY_KEY_INVALID');
    }
    try {
      return createHmac('sha256', key).update(stableJson(payload), 'utf8').digest('base64url');
    } finally {
      key.fill(0);
    }
  }

  private assertChainPayload(payload: AuditChainPayload): void {
    const candidate: unknown = payload;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !CHAIN_PAYLOAD_KEYS.has(key)) ||
      typeof candidate.metadataCanonical !== 'string'
    ) throw new Error('AUDIT_CHAIN_PAYLOAD_INVALID');
    let metadata: unknown;
    try {
      metadata = JSON.parse(candidate.metadataCanonical) as unknown;
    } catch (error) {
      throw new Error('AUDIT_CHAIN_PAYLOAD_INVALID', { cause: error });
    }
    const normalizedEvent = auditEventSchema.safeParse({
      tenantId: candidate.tenantId,
      actorId: candidate.actorId,
      actorType: candidate.actorType,
      action: candidate.action,
      resourceType: candidate.resourceType,
      ...(candidate.resourceId === undefined ? {} : { resourceId: candidate.resourceId }),
      riskLevel: candidate.riskLevel,
      outcome: candidate.outcome,
      occurredAt: candidate.occurredAt,
      traceId: candidate.traceId,
      metadata,
    });
    if (
      !normalizedEvent.success ||
      stableJson(normalizedEvent.data.metadata ?? {}) !== candidate.metadataCanonical ||
      typeof candidate.sequence !== 'number' ||
      !Number.isSafeInteger(candidate.sequence) ||
      candidate.sequence < 1 ||
      typeof candidate.eventId !== 'string' ||
      !ID_PATTERN.test(candidate.eventId) ||
      typeof candidate.previousHash !== 'string' ||
      !HASH_PATTERN.test(candidate.previousHash) ||
      decodeCanonicalHash(candidate.previousHash) === null ||
      candidate.metadataCanonical.length > 4_096
    ) throw new Error('AUDIT_CHAIN_PAYLOAD_INVALID');
  }
}

function decodeCanonicalHash(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
