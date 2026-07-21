import { createHmac, randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { OpApprovalBridgeJobData } from './op-approval.queue.js';
import { OpApprovalWebhookService } from './op-approval-webhook.service.js';
import { OpApprovalWebhookCryptoService } from './op-approval-webhook-crypto.service.js';
import type { ProtectedOpWebhook } from './op-webhook-crypto.service.js';
import { OpWebhookSecretResolver } from './op-webhook.service.js';
import type {
  OpApprovalRequestInboxDocument,
  OpApprovalRouteDocument,
  OpClientBindingDocument,
} from './persistence/op.schemas.js';

const NOW = new Date('2026-07-22T08:00:00.000Z');
const CLIENT_ID = 'op-client-001';
const EVENT_ID = 'approval-event-001';
const NONCE = 'nonce_1234567890abcdef';
const SECRET_REF = 'GAOQ_OP_HMAC_APPROVAL_TEST';
const SECRET = 'test-only-op-approval-secret-at-least-32-characters';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function rawBody(extra: Readonly<Record<string, unknown>> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: '1.0', type: 'approval.requested', occurredAt: NOW.toISOString(),
    data: {
      sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
      initiatorEmployeeId: 'employee-001', title: '采购审批', formData: { amount: 12_345 },
    },
    ...extra,
  }));
}

function signedHeaders(raw: Buffer, signature?: string) {
  const timestamp = String(NOW.getTime());
  return {
    clientId: CLIENT_ID, timestamp, nonce: NONCE, eventId: EVENT_ID,
    signature: signature ?? createHmac('sha256', SECRET)
      .update(`${timestamp}\n${NONCE}\n${EVENT_ID}\n`, 'utf8').update(raw).digest('hex'),
    algorithm: 'hmac-sha256',
  };
}

function fixture(existing: Record<string, unknown> | null = null, routeExists = true) {
  const bindings = { findOne: vi.fn().mockReturnValue(query({
    tenantId: 'tenant-001', clientId: CLIENT_ID, credentialSecretRef: SECRET_REF,
  })) };
  const routes = { exists: vi.fn().mockResolvedValue(routeExists ? { _id: 'route-001' } : null) };
  const inbox = {
    findOne: vi.fn().mockReturnValue(query(existing)), create: vi.fn().mockResolvedValue(undefined),
  };
  const redis = { set: vi.fn().mockResolvedValue('OK') };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-001' }) };
  const audit = { recordTrustedExternalService: vi.fn().mockResolvedValue(undefined) };
  const crypto = new OpApprovalWebhookCryptoService(new ConfigService<AppEnvironment, true>({
    OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'op-key-001', keys: [{
        keyId: 'op-key-001', keyBase64url: randomBytes(32).toString('base64url'), status: 'active',
      }],
    }),
  } as AppEnvironment));
  const service = new OpApprovalWebhookService(
    bindings as unknown as Model<OpClientBindingDocument>,
    routes as unknown as Model<OpApprovalRouteDocument>,
    inbox as unknown as Model<OpApprovalRequestInboxDocument>,
    new OpWebhookSecretResolver(), crypto, audit as unknown as AuditService,
    redis as unknown as Redis, queue as unknown as Queue<OpApprovalBridgeJobData>,
  );
  return { service, bindings, routes, inbox, redis, queue, audit, crypto };
}

describe('OpApprovalWebhookService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env[SECRET_REF] = SECRET;
  });

  afterEach(() => {
    delete process.env[SECRET_REF];
    vi.useRealTimers();
  });

  it('验签后以客户端绑定租户、ERP 路由和加密 Inbox 接收审批', async () => {
    const store = fixture();
    const raw = rawBody();
    const result = await store.service.accept(signedHeaders(raw), raw);
    const record = store.inbox.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result.duplicate).toBe(false);
    expect(store.routes.exists).toHaveBeenCalledWith({
      tenantId: 'tenant-001', inboundClientId: CLIENT_ID,
      sourceDocumentType: 'purchase_order', status: 'active',
    });
    expect(record).toMatchObject({
      tenantId: 'tenant-001', clientId: CLIENT_ID, externalEventId: EVENT_ID,
      status: 'pending', attempts: 0,
    });
    expect(JSON.stringify(record)).not.toMatch(/purchase_order|employee-001|amount/iu);
    expect(store.crypto.unprotect(
      'tenant-001', result.inboxId, record as unknown as ProtectedOpWebhook,
    )).toEqual(raw);
    expect(store.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^op:webhook:approval:nonce:/), expect.any(String),
      'EX', 86_400, 'NX',
    );
    expect(store.queue.add).toHaveBeenCalledWith(
      'op.process-approval-request',
      { inboxId: result.inboxId, tenantId: 'tenant-001' },
      expect.objectContaining({ attempts: 12 }),
    );
  });

  it('拒绝 OP 自选模板、未配置路由和错误签名', async () => {
    const templateBody = rawBody({ templateCode: 'BYPASS' });
    await expect(fixture().service.accept(signedHeaders(templateBody), templateBody))
      .rejects.toMatchObject({ response: { code: 'OP_APPROVAL_BODY_INVALID' } });
    const raw = rawBody();
    await expect(fixture(null, false).service.accept(signedHeaders(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_APPROVAL_ROUTE_NOT_FOUND' } });
    await expect(fixture().service.accept(signedHeaders(raw, '0'.repeat(64)), raw))
      .rejects.toMatchObject({ response: { code: 'OP_APPROVAL_VERIFICATION_FAILED' } });
  });

  it('相同事件同载荷幂等接受，不同载荷冲突', async () => {
    const raw = rawBody();
    const payloadHash = (await import('./op-approval.contract.js')).hashOpApprovalPayload(raw);
    const duplicate = fixture({
      id: '01K00000000000000000000001', tenantId: 'tenant-001', payloadHash,
    });
    await expect(duplicate.service.accept(signedHeaders(raw), raw)).resolves.toEqual({
      inboxId: '01K00000000000000000000001', duplicate: true,
    });
    expect(duplicate.redis.set).not.toHaveBeenCalled();
    const conflict = fixture({
      id: '01K00000000000000000000001', tenantId: 'tenant-001', payloadHash: 'x'.repeat(43),
    });
    await expect(conflict.service.accept(signedHeaders(raw), raw))
      .rejects.toMatchObject({ response: { code: 'OP_APPROVAL_EVENT_CONFLICT' } });
  });
});
