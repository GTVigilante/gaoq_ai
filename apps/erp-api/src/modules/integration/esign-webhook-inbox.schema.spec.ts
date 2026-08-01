import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ESignWebhookInboxRecordSchema,
  type ESignWebhookInboxRecord,
} from './esign-webhook-inbox.schema.js';

const mongoose = new Mongoose();
const InboxModel = mongoose.model<ESignWebhookInboxRecord>(
  'SpecESignWebhookInbox',
  ESignWebhookInboxRecordSchema,
);

function record(overrides?: Readonly<Record<string, unknown>>) {
  return {
    id: '01K00000000000000000000000',
    tenantId: 'tenant-001',
    provider: 'esign_cn',
    appId: 'app12345',
    providerEventId: 'A'.repeat(43),
    action: 'SIGN_FLOW_COMPLETE',
    providerOccurredAt: new Date('2026-07-21T08:00:00.000Z'),
    payloadKeyId: 'esign-key-001',
    payloadIv: 'A'.repeat(16),
    payloadCiphertext: 'B'.repeat(32),
    payloadAuthTag: 'C'.repeat(22),
    status: 'pending',
    attempts: 0,
    failureCode: null,
    processedAt: null,
    processingStartedAt: null,
    processingToken: null,
    processingJobId: null,
    ...overrides,
  };
}

describe('ESignWebhookInboxRecordSchema', () => {
  it('pending 不携带租约，processing 必须同时绑定时间、随机令牌与任务标识', async () => {
    await expect(new InboxModel(record()).validate()).resolves.toBeUndefined();
    await expect(new InboxModel(record({
      status: 'processing',
      attempts: 1,
      processingStartedAt: new Date('2026-07-21T08:01:00.000Z'),
      processingToken: 'A'.repeat(22),
      processingJobId: `esign_webhook_${'B'.repeat(43)}`,
    })).validate()).resolves.toBeUndefined();
  });

  it.each([
    [{ status: 'processing' }],
    [{
      status: 'processing',
      processingStartedAt: new Date(),
      processingToken: 'A'.repeat(22),
    }],
    [{
      status: 'failed',
      processingStartedAt: new Date(),
      processingToken: 'A'.repeat(22),
      processingJobId: 'job-001',
    }],
  ])('拒绝状态与租约组合不一致：%s', async (overrides) => {
    await expect(new InboxModel(record(overrides)).validate())
      .rejects.toThrow('eSign Inbox 处理状态与租约字段不一致');
  });

  it('处理令牌必须是 16 字节规范 base64url 长度', async () => {
    await expect(new InboxModel(record({
      status: 'processing',
      processingStartedAt: new Date(),
      processingToken: 'short',
      processingJobId: 'job-001',
    })).validate()).rejects.toThrow();
  });

  it('提供租户内 Inbox 与供应商事件唯一键及状态扫描索引', () => {
    expect(ESignWebhookInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, id: 1 },
      { unique: true },
    ]);
    expect(ESignWebhookInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, provider: 1, appId: 1, providerEventId: 1 },
      { unique: true },
    ]);
    expect(ESignWebhookInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, status: 1, createdAt: 1 },
      {},
    ]);
  });
});
