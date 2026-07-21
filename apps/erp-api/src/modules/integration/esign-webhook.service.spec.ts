import { createHmac, randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import type { ESignWebhookInboxDocument } from './esign-webhook-inbox.schema.js';
import type { ESignWebhookJobData } from './esign-webhook.queue.js';
import { ESignSecretResolver, ESignWebhookService } from './esign-webhook.service.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');
const APP_ID = 'app12345';
const SECRET_REF = 'GAOQ_ESIGN_APP_TEST';
const SECRET = 'test-only-webhook-secret';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function rawBody(action = 'SIGN_FLOW_COMPLETE', occurredAt = NOW): Buffer {
  return Buffer.from(JSON.stringify({
    action, timestamp: occurredAt.getTime(), data: {
      signFlowId: 'external-flow-001', signFlowTitle: '张三劳动合同',
      signFlowStatus: 2, statusDescription: '完成',
    },
  }));
}

function headers(body: Buffer, signature?: string) {
  return {
    appId: APP_ID,
    timestamp: String(NOW.getTime()),
    signature: signature ?? createHmac('sha256', SECRET)
      .update(String(NOW.getTime()), 'utf8').update(body).digest('hex'),
    algorithm: 'hmac-sha256',
  };
}

function fixture(existing: Record<string, unknown> | null = null) {
  const bindings = { findOne: vi.fn().mockReturnValue(query({
    tenantId: 'tenant-001', appId: APP_ID, credentialSecretRef: SECRET_REF,
  })) };
  const inbox = {
    findOne: vi.fn().mockReturnValue(query(existing)),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-001' }) };
  const crypto = new ESignWebhookCryptoService(new ConfigService<AppEnvironment, true>({
    ESIGN_WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'esign-key-001',
      keys: [{
        keyId: 'esign-key-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
  } as AppEnvironment));
  const service = new ESignWebhookService(
    bindings as unknown as Model<ESignBindingDocument>,
    inbox as unknown as Model<ESignWebhookInboxDocument>,
    new ESignSecretResolver(),
    crypto,
    queue as unknown as Queue<ESignWebhookJobData>,
  );
  return { service, bindings, inbox, queue, crypto };
}

describe('ESignWebhookService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env[SECRET_REF] = SECRET;
  });

  afterEach(() => {
    delete process.env[SECRET_REF];
    vi.useRealTimers();
  });

  it('验签后从 appId 绑定解析租户、加密入箱并幂等排队', async () => {
    const store = fixture();
    const body = rawBody();
    const result = await store.service.accept(headers(body), body);
    expect(result.duplicate).toBe(false);
    expect(store.bindings.findOne).toHaveBeenCalledWith({
      provider: 'esign_cn', appId: APP_ID, status: 'active',
    });
    const record = store.inbox.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(record).toMatchObject({
      id: result.inboxId, tenantId: 'tenant-001', provider: 'esign_cn', appId: APP_ID,
      action: 'SIGN_FLOW_COMPLETE', status: 'pending', attempts: 0,
    });
    expect(JSON.stringify(record)).not.toMatch(/张三|劳动合同|external-flow-001/u);
    expect(typeof record.payloadCiphertext).toBe('string');
    const queued = store.queue.add.mock.calls[0] as unknown as [
      string,
      Readonly<Record<string, unknown>>,
      Readonly<Record<string, unknown>>,
    ];
    expect(queued[0]).toBe('process:esign:webhook');
    expect(queued[1]).toEqual({ inboxId: result.inboxId, tenantId: 'tenant-001' });
    expect(queued[2]).toMatchObject({ attempts: 12 });
    expect(queued[2].jobId).toMatch(/^esign_[A-Za-z0-9_-]{43}$/);
  });

  it('同一原始事件重试复用 Inbox 且不重复写入', async () => {
    const existing = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001', status: 'pending',
    };
    const store = fixture(existing);
    const body = rawBody();
    const result = await store.service.accept(headers(body), body);
    expect(result).toEqual({ inboxId: existing.id, duplicate: true });
    expect(store.inbox.create).not.toHaveBeenCalled();
    expect(store.queue.add).toHaveBeenCalledOnce();
  });

  it('签名、时间窗或算法错误时不入箱、不推进业务状态', async () => {
    const store = fixture();
    const body = rawBody();
    await expect(store.service.accept(headers(body, '0'.repeat(64)), body))
      .rejects.toMatchObject({ response: { code: 'ESIGN_WEBHOOK_VERIFICATION_FAILED' } });
    expect(store.inbox.create).not.toHaveBeenCalled();
    await expect(store.service.accept({ ...headers(body), algorithm: 'sha1' }, body))
      .rejects.toMatchObject({ response: { code: 'ESIGN_WEBHOOK_VERIFICATION_FAILED' } });
  });

  it('未知 action 仍加密入箱，留给异步消费者标记 ignored', async () => {
    const store = fixture();
    const body = rawBody('FUTURE_ACTION_V9');
    await store.service.accept(headers(body), body);
    expect(store.inbox.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'FUTURE_ACTION_V9', status: 'pending',
    }));
  });

  it('供应商对历史事件重试时使用新请求时间验签，不误杀幂等重放', async () => {
    const store = fixture();
    const body = rawBody('SIGN_FLOW_COMPLETE', new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1_000));
    await expect(store.service.accept(headers(body), body)).resolves.toMatchObject({
      duplicate: false,
    });
  });
});
