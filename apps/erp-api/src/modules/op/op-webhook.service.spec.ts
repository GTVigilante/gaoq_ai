import { createHmac, randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { OpOperatingSummaryJobData } from './op-operating-summary.queue.js';
import { OpWebhookCryptoService } from './op-webhook-crypto.service.js';
import { OpWebhookSecretResolver, OpWebhookService } from './op-webhook.service.js';
import type {
  OpClientBindingDocument,
  OpOperatingSummaryInboxDocument,
} from './persistence/op.schemas.js';

const NOW = new Date('2026-07-22T08:00:00.000Z');
const CLIENT_ID = 'op-client-001';
const EVENT_ID = 'event-20260722-001';
const NONCE = 'nonce_1234567890abcdef';
const SECRET_REF = 'GAOQ_OP_HMAC_TEST';
const SECRET = 'test-only-op-hmac-secret-at-least-32-characters';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function body(extra: Readonly<Record<string, unknown>> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: '1.0', type: 'operating.summary.published',
    occurredAt: NOW.toISOString(),
    data: {
      summaryDate: '2026-07-22', revision: 1, currency: 'CNY',
      metrics: {
        gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
        refundOrderCount: 1, activeCustomerCount: 8,
      },
    },
    ...extra,
  }));
}

function headers(raw: Buffer, signature?: string) {
  const timestamp = String(NOW.getTime());
  return {
    clientId: CLIENT_ID, timestamp, nonce: NONCE, eventId: EVENT_ID,
    signature: signature ?? createHmac('sha256', SECRET)
      .update(`${timestamp}\n${NONCE}\n${EVENT_ID}\n`, 'utf8').update(raw).digest('hex'),
    algorithm: 'hmac-sha256',
  };
}

function fixture(existing: Record<string, unknown> | null = null) {
  const bindings = { findOne: vi.fn().mockReturnValue(query({
    tenantId: 'tenant-001', clientId: CLIENT_ID, credentialSecretRef: SECRET_REF,
  })) };
  const inbox = {
    findOne: vi.fn().mockReturnValue(query(existing)), create: vi.fn().mockResolvedValue(undefined),
  };
  const redis = { set: vi.fn().mockResolvedValue('OK') };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-001' }) };
  const audit = { recordTrustedExternalService: vi.fn().mockResolvedValue(undefined) };
  const crypto = new OpWebhookCryptoService(new ConfigService<AppEnvironment, true>({
    OP_WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'op-key-001', keys: [{
        keyId: 'op-key-001', keyBase64url: randomBytes(32).toString('base64url'), status: 'active',
      }],
    }),
  } as AppEnvironment));
  const service = new OpWebhookService(
    bindings as unknown as Model<OpClientBindingDocument>,
    inbox as unknown as Model<OpOperatingSummaryInboxDocument>,
    new OpWebhookSecretResolver(), crypto, audit as unknown as AuditService,
    redis as unknown as Redis,
    queue as unknown as Queue<OpOperatingSummaryJobData>,
  );
  return { service, bindings, inbox, redis, queue, crypto, audit };
}

describe('OpWebhookService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env[SECRET_REF] = SECRET;
  });

  afterEach(() => {
    delete process.env[SECRET_REF];
    vi.useRealTimers();
  });

  it('验签后按 clientId 解析租户、防重放、加密入箱并排队', async () => {
    const store = fixture();
    const raw = body();
    const result = await store.service.accept(headers(raw), raw);
    const record = store.inbox.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result.duplicate).toBe(false);
    expect(store.bindings.findOne).toHaveBeenCalledWith({ clientId: CLIENT_ID, status: 'active' });
    expect(store.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^op:webhook:nonce:/), expect.any(String), 'EX', 86_400, 'NX',
    );
    expect(record).toMatchObject({
      id: result.inboxId, tenantId: 'tenant-001', clientId: CLIENT_ID,
      externalEventId: EVENT_ID, status: 'pending', attempts: 0,
    });
    expect(JSON.stringify(record)).not.toMatch(/gmvMinor|summaryDate/u);
    expect(typeof record.payloadCiphertext).toBe('string');
    expect(new Date(record.expiresAt as Date).getTime() - NOW.getTime())
      .toBe(90 * 24 * 60 * 60 * 1_000);
    expect(store.queue.add).toHaveBeenCalledWith(
      'op.process-operating-summary',
      { inboxId: result.inboxId, tenantId: 'tenant-001' },
      expect.objectContaining({ attempts: 12 }),
    );
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001', expect.objectContaining({
        actorId: `op:${CLIENT_ID}`, action: 'integration.op.webhook.verify', outcome: 'success',
      }),
    );
  });

  it('拒绝错误签名、伪造 tenantId 和 Redis 防重放失败', async () => {
    const signed = body();
    const store = fixture();
    await expect(store.service.accept(headers(signed, '0'.repeat(64)), signed))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_VERIFICATION_FAILED' } });
    const forged = body({ tenantId: 'forged-tenant' });
    await expect(store.service.accept(headers(forged), forged))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_BODY_INVALID' } });
    store.redis.set.mockResolvedValueOnce(null);
    await expect(store.service.accept(headers(signed), signed))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_REPLAY_DETECTED' } });
    expect(store.inbox.create).not.toHaveBeenCalled();
  });

  it('同一事件同一载荷复用 Inbox，不重复创建修订', async () => {
    const raw = body();
    const payloadHash = (await import('./op-operating-summary.contract.js')).hashOpPayload(raw);
    const existing = {
      id: '01K00000000000000000000001', tenantId: 'tenant-001', payloadHash,
    };
    const store = fixture(existing);
    await expect(store.service.accept(headers(raw), raw)).resolves.toEqual({
      inboxId: existing.id, duplicate: true,
    });
    expect(store.redis.set).not.toHaveBeenCalled();
    expect(store.inbox.create).not.toHaveBeenCalled();
  });

  it('超过 1 MiB 的原始正文以 413 失败关闭', async () => {
    const store = fixture();
    const raw = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await expect(store.service.accept(headers(raw), raw)).rejects.toMatchObject({
      status: 413, response: { code: 'OP_WEBHOOK_BODY_TOO_LARGE' },
    });
    expect(store.bindings.findOne).not.toHaveBeenCalled();
    expect(store.inbox.create).not.toHaveBeenCalled();
  });
});
