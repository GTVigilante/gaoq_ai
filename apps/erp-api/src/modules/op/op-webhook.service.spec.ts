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

  it.each([
    ['clientId 缺失', { clientId: undefined }],
    ['clientId 非法', { clientId: 'bad' }],
    ['时间戳缺失', { timestamp: undefined }],
    ['时间戳格式非法', { timestamp: '123' }],
    ['时间戳过期', { timestamp: String(NOW.getTime() - 300_001) }],
    ['nonce 缺失', { nonce: undefined }],
    ['nonce 非法', { nonce: 'short' }],
    ['eventId 缺失', { eventId: undefined }],
    ['eventId 非法', { eventId: 'short' }],
    ['签名缺失', { signature: undefined }],
    ['签名格式非法', { signature: 'g'.repeat(64) }],
    ['算法缺失', { algorithm: undefined }],
    ['算法非法', { algorithm: 'sha256' }],
  ])('认证头失败关闭：%s', async (_name, override) => {
    const store = fixture();
    const raw = body();
    await expect(store.service.accept({ ...headers(raw), ...override }, raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_VERIFICATION_FAILED' } });
    expect(store.bindings.findOne).not.toHaveBeenCalled();
  });

  it('接受大小写等价算法并拒绝缺失或过短正文', async () => {
    const valid = fixture();
    const raw = body();
    await expect(valid.service.accept(
      { ...headers(raw), algorithm: 'HMAC-SHA256' },
      raw,
    )).resolves.toMatchObject({ duplicate: false });

    for (const missing of [undefined, Buffer.alloc(0), Buffer.from('x')]) {
      const store = fixture();
      await expect(store.service.accept(headers(raw), missing))
        .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_RAW_BODY_REQUIRED' } });
      expect(store.bindings.findOne).not.toHaveBeenCalled();
    }
  });

  it('未知或停用 clientId 不解析租户也不写租户审计', async () => {
    const store = fixture();
    const raw = body();
    store.bindings.findOne.mockReturnValueOnce(query(null));

    await expect(store.service.accept(headers(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_VERIFICATION_FAILED' } });
    expect(store.audit.recordTrustedExternalService).not.toHaveBeenCalled();
  });

  it.each([
    'OTHER_SECRET',
    'GAOQ_OP_HMAC_',
  ])('Secret 引用越出专用命名空间时拒绝：%s', (reference) => {
    expect(() => new OpWebhookSecretResolver().resolve(reference))
      .toThrowError(/OP 回调验证失败/u);
  });

  it.each([
    undefined,
    'short',
    'x'.repeat(2_049),
  ])('Secret 为 %s 时验证设施失败关闭', (secret) => {
    const reference = 'GAOQ_OP_HMAC_BOUNDARY';
    if (secret !== undefined) process.env[reference] = secret;
    try {
      expect(() => new OpWebhookSecretResolver().resolve(reference))
        .toThrowError(/OP 回调验证暂不可用/u);
    } finally {
      delete process.env[reference];
    }
  });

  it('签名失败审计异常不覆盖统一认证错误', async () => {
    const store = fixture();
    const raw = body();
    store.audit.recordTrustedExternalService.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(store.service.accept(headers(raw, '0'.repeat(64)), raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_VERIFICATION_FAILED' } });
    expect(store.inbox.create).not.toHaveBeenCalled();
  });

  it.each([
    ['非法 JSON', Buffer.from('{{')],
    ['未知字段', body({ unknown: true })],
  ])('拒绝不符合严格契约的正文：%s', async (_name, raw) => {
    const store = fixture();
    await expect(store.service.accept(headers(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_BODY_INVALID' } });
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it.each([
    NOW.getTime() + 300_001,
    NOW.getTime() - 31 * 24 * 60 * 60 * 1_000 - 1,
  ])('拒绝供应商事件时间越出窗口：%s', async (occurredAt) => {
    const store = fixture();
    const raw = body({ occurredAt: new Date(occurredAt).toISOString() });
    await expect(store.service.accept(headers(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_VERIFICATION_FAILED' } });
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ traceId: EVENT_ID, outcome: 'failure' }),
    );
  });

  it('同一事件异载荷冲突并写失败审计', async () => {
    const raw = body();
    const store = fixture({
      id: '01K00000000000000000000001',
      tenantId: 'tenant-001',
      payloadHash: 'x'.repeat(43),
    });

    await expect(store.service.accept(headers(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_EVENT_PAYLOAD_CONFLICT' } });
    expect(store.redis.set).not.toHaveBeenCalled();
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it.each([
    ['Redis 返回非 OK', null],
    ['Redis 连接失败', new Error('redis unavailable')],
  ])('防重放设施失败关闭：%s', async (_name, result) => {
    const store = fixture();
    const raw = body();
    if (result instanceof Error) store.redis.set.mockRejectedValueOnce(result);
    else store.redis.set.mockResolvedValueOnce(result);

    await expect(store.service.accept(headers(raw), raw)).rejects.toMatchObject({
      response: {
        code: result instanceof Error
          ? 'OP_WEBHOOK_REPLAY_STORE_UNAVAILABLE'
          : 'OP_WEBHOOK_REPLAY_DETECTED',
      },
    });
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('数据库非唯一错误保持原始失败且不排队', async () => {
    const store = fixture();
    const raw = body();
    const failure = new Error('database unavailable');
    store.inbox.create.mockRejectedValueOnce(failure);

    await expect(store.service.accept(headers(raw), raw)).rejects.toBe(failure);
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['竞态记录缺失', null],
    ['竞态记录异载荷', {
      id: '01K00000000000000000000002',
      tenantId: 'tenant-001',
      payloadHash: 'x'.repeat(43),
    }],
  ])('唯一键竞态失败关闭：%s', async (_name, raced) => {
    const store = fixture();
    const raw = body();
    store.inbox.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(raced));
    store.inbox.create.mockRejectedValueOnce({ code: 11_000 });

    await expect(store.service.accept(headers(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_WEBHOOK_REPLAY_DETECTED' } });
    expect(store.queue.add).not.toHaveBeenCalled();
    expect(store.audit.recordTrustedExternalService).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ traceId: EVENT_ID, outcome: 'failure' }),
    );
  });

  it('唯一键竞态同载荷恢复首次 Inbox 并确保排队', async () => {
    const raw = body();
    const payloadHash = (await import('./op-operating-summary.contract.js')).hashOpPayload(raw);
    const raced = {
      id: '01K00000000000000000000002',
      tenantId: 'tenant-001',
      payloadHash,
    };
    const store = fixture();
    store.inbox.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(raced));
    store.inbox.create.mockRejectedValueOnce({ code: 11_000 });

    await expect(store.service.accept(headers(raw), raw)).resolves.toEqual({
      inboxId: raced.id,
      duplicate: true,
    });
    expect(store.queue.add).toHaveBeenCalledWith(
      'op.process-operating-summary',
      { inboxId: raced.id, tenantId: raced.tenantId },
      expect.objectContaining({ jobId: `op_summary_${payloadHash}` }),
    );
  });

  it.each([
    ['首次接收', null],
    ['幂等重试', 'existing'],
  ])('成功终态后的审计故障不反向暴露失败：%s', async (_name, mode) => {
    const raw = body();
    const payloadHash = (await import('./op-operating-summary.contract.js')).hashOpPayload(raw);
    const existing = mode === 'existing' ? {
      id: '01K00000000000000000000001',
      tenantId: 'tenant-001',
      payloadHash,
    } : null;
    const store = fixture(existing);
    store.audit.recordTrustedExternalService.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(store.service.accept(headers(raw), raw))
      .resolves.toMatchObject({ duplicate: mode === 'existing' });
    expect(store.queue.add).toHaveBeenCalledOnce();
  });
});
