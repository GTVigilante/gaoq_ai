import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type {
  AppliedOpOperatingSummary,
  OpOperatingSummaryService,
} from './application/op-operating-summary.service.js';
import { hashOpPayload } from './op-operating-summary.contract.js';
import {
  OpOperatingSummaryProcessor,
} from './op-operating-summary.processor.js';
import {
  OP_PROCESS_OPERATING_SUMMARY_JOB,
  type OpOperatingSummaryJobData,
} from './op-operating-summary.queue.js';
import type { OpWebhookCryptoService } from './op-webhook-crypto.service.js';
import type {
  OpOperatingSummaryInboxDocument,
  OpOperatingSummaryInboxRecord,
} from './persistence/op.schemas.js';

const NOW = new Date('2026-07-28T08:00:00.000Z');
const INBOX_ID = '01K00000000000000000000001';
const JOB_ID = `op_summary_${'j'.repeat(43)}`;

const envelope = {
  schemaVersion: '1.0',
  type: 'operating.summary.published',
  occurredAt: '2026-07-22T08:00:00.000Z',
  data: {
    summaryDate: '2026-07-22',
    revision: 1,
    currency: 'CNY',
    metrics: {
      gmvMinor: 123_456,
      paidOrderCount: 12,
      refundMinor: 500,
      refundOrderCount: 1,
      activeCustomerCount: 8,
    },
  },
};

const rawBody = Buffer.from(JSON.stringify(envelope));

const claimedRecord = (
  overrides: Partial<OpOperatingSummaryInboxRecord> = {},
): OpOperatingSummaryInboxRecord => ({
  id: INBOX_ID,
  tenantId: 'tenant-001',
  clientId: 'op-client-001',
  externalEventId: 'event-20260722-001',
  nonceHash: 'n'.repeat(43),
  payloadHash: hashOpPayload(rawBody),
  providerOccurredAt: new Date(envelope.occurredAt),
  receivedAt: new Date('2026-07-22T08:00:01.000Z'),
  expiresAt: new Date('2026-10-20T08:00:01.000Z'),
  payloadKeyId: 'op-key-001',
  payloadIv: 'i'.repeat(16),
  payloadCiphertext: 'c'.repeat(16),
  payloadAuthTag: 'a'.repeat(22),
  status: 'processing',
  attempts: 1,
  failureCode: null,
  processedAt: null,
  processingStartedAt: NOW,
  processingJobId: JOB_ID,
  processingToken: 't'.repeat(22),
  createdAt: new Date('2026-07-22T08:00:01.000Z'),
  updatedAt: new Date('2026-07-22T08:00:01.000Z'),
  ...overrides,
});

const summary: AppliedOpOperatingSummary = Object.freeze({
  id: '01K00000000000000000000002',
  summaryDate: '2026-07-22',
  revision: 1,
  currency: 'CNY',
  metrics: Object.freeze({
    gmvMinor: 123_456,
    paidOrderCount: 12,
    refundMinor: 500,
    refundOrderCount: 1,
    activeCustomerCount: 8,
  }),
  payloadHash: hashOpPayload(rawBody),
  occurredAt: envelope.occurredAt,
  receivedAt: '2026-07-22T08:00:01.000Z',
});

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function fixture(claimed: OpOperatingSummaryInboxRecord | null = claimedRecord()) {
  const inbox = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const crypto = { unprotect: vi.fn().mockReturnValue(rawBody) };
  const summaries = { apply: vi.fn().mockResolvedValue(summary) };
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const context = new TenantContextService();
  const processor = new OpOperatingSummaryProcessor(
    inbox as unknown as Model<OpOperatingSummaryInboxDocument>,
    crypto as unknown as OpWebhookCryptoService,
    summaries as unknown as OpOperatingSummaryService,
    audit as unknown as AuditService,
    context,
  );
  return { processor, inbox, crypto, summaries, audit, context };
}

function job(
  overrides: Partial<Job<OpOperatingSummaryJobData>> = {},
): Job<OpOperatingSummaryJobData> {
  return {
    name: OP_PROCESS_OPERATING_SUMMARY_JOB,
    id: JOB_ID,
    data: { tenantId: 'tenant-001', inboxId: INBOX_ID },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  } as Job<OpOperatingSummaryJobData>;
}

describe('OpOperatingSummaryProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('以 Job 级租约认领并在可信系统上下文提交摘要、终态和最小审计', async () => {
    const store = fixture();

    await expect(store.processor.process(job())).resolves.toBe(1);

    const claimFilter = store.inbox.findOneAndUpdate.mock.calls[0]?.[0] as unknown;
    expect(claimFilter).toEqual({
      tenantId: 'tenant-001',
      id: INBOX_ID,
      attempts: { $lt: 100 },
      $or: [
        { status: 'pending' },
        { status: 'processing', processingJobId: JOB_ID },
        {
          status: 'processing',
          processingStartedAt: { $lte: new Date(NOW.getTime() - 15 * 60 * 1_000) },
        },
      ],
    });
    expect(store.summaries.apply).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      clientId: 'op-client-001',
      externalEventId: 'event-20260722-001',
      inboxId: INBOX_ID,
      payloadHash: hashOpPayload(rawBody),
    }));
    const finalFilter = store.inbox.updateOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(finalFilter).toMatchObject({
      tenantId: 'tenant-001',
      id: INBOX_ID,
      status: 'processing',
      processingJobId: JOB_ID,
    });
    expect(finalFilter['processingToken']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toEqual({
      $set: {
        status: 'completed',
        failureCode: null,
        processedAt: NOW,
        processingStartedAt: null,
        processingJobId: null,
        processingToken: null,
      },
    });
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        action: 'op.operating_summary.apply',
        resourceId: summary.id,
        outcome: 'success',
        traceId: INBOX_ID,
      }),
    );
  });

  it('已由其他 Job 完成或持有的 Inbox 不重复处理', async () => {
    const store = fixture(null);
    await expect(store.processor.process(job())).resolves.toBe(0);
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
    expect(store.summaries.apply).not.toHaveBeenCalled();
    expect(store.inbox.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['未知任务名', { name: 'unknown' }, 'OP_JOB_UNKNOWN'],
    ['缺失任务 ID', { id: undefined }, 'OP_JOB_ID_INVALID'],
    ['非法任务 ID', { id: 'contains space' }, 'OP_JOB_ID_INVALID'],
    ['非法任务载荷', { data: { tenantId: 'tenant-001', inboxId: 'bad' } }, undefined],
  ])('%s在访问 Inbox 前失败关闭', async (_name, override, code) => {
    const store = fixture();
    const operation = store.processor.process(job(override as Partial<Job<OpOperatingSummaryJobData>>));
    if (code === undefined) await expect(operation).rejects.toBeDefined();
    else await expect(operation).rejects.toThrow(code);
    expect(store.inbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['载荷摘要不匹配', Buffer.from('{}'), claimedRecord(), 'OP_PAYLOAD_HASH_MISMATCH'],
    ['非法 JSON', Buffer.from('{{'), claimedRecord({
      payloadHash: hashOpPayload(Buffer.from('{{')),
    }), 'OP_WEBHOOK_BODY_INVALID'],
    ['严格契约不匹配', Buffer.from('{}'), claimedRecord({
      payloadHash: hashOpPayload(Buffer.from('{}')),
    }), 'OP_WEBHOOK_BODY_INVALID'],
    ['事件时间不匹配', rawBody, claimedRecord({
      providerOccurredAt: new Date('2026-07-22T08:00:00.001Z'),
    }), 'OP_ENVELOPE_TIME_MISMATCH'],
  ])('%s属于永久失败，落 failed 后不触发 BullMQ 重试', async (
    _name,
    body,
    claimed,
    failureCode,
  ) => {
    const store = fixture(claimed);
    store.crypto.unprotect.mockReturnValueOnce(body);

    await expect(store.processor.process(job())).resolves.toBe(1);

    expect(store.inbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        id: INBOX_ID,
        status: 'processing',
        processingJobId: JOB_ID,
      }),
      { $set: {
        status: 'failed',
        failureCode,
        processedAt: null,
        processingStartedAt: null,
        processingJobId: null,
        processingToken: null,
      } },
      { runValidators: true },
    );
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        resourceType: 'op_operating_summary_inbox',
        outcome: 'failure',
        metadata: { failureCode },
      }),
    );
  });

  it('应用服务 4xx 保留稳定错误码并作为永久失败封存', async () => {
    const store = fixture();
    store.summaries.apply.mockRejectedValueOnce(new ConflictException({
      code: 'OP_OPERATING_SUMMARY_REVISION_INVALID',
      message: 'revision invalid',
    }));

    await expect(store.processor.process(job())).resolves.toBe(1);
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'failed', failureCode: 'OP_OPERATING_SUMMARY_REVISION_INVALID' },
    });
  });

  it('暂时性失败只登记本次错误并由同一 JobId 重试，不提前写终态', async () => {
    const store = fixture();
    const failure = new ServiceUnavailableException({
      code: 'OP_DATABASE_UNAVAILABLE',
      message: 'temporarily unavailable',
    });
    store.summaries.apply.mockRejectedValueOnce(failure);

    await expect(store.processor.process(job())).rejects.toBe(failure);

    const retryCall = store.inbox.updateOne.mock.calls[0] as unknown as [
      Readonly<Record<string, unknown>>,
      Readonly<Record<string, unknown>>,
      Readonly<Record<string, unknown>>,
    ];
    expect(retryCall[0]).toMatchObject({
      status: 'processing',
      processingJobId: JOB_ID,
    });
    expect(retryCall[0]['processingToken']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(retryCall[1]).toEqual({ $set: { failureCode: 'OP_DATABASE_UNAVAILABLE' } });
    expect(retryCall[2]).toEqual({ runValidators: true });
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).not.toHaveProperty('$set.status');
  });

  it.each([
    ['大写错误码', new Error('OP_GATEWAY_UNAVAILABLE'), 'OP_GATEWAY_UNAVAILABLE'],
    ['未知异常', Object.freeze({ reason: 'unknown' }), 'OP_OPERATING_SUMMARY_PROCESSING_FAILED'],
  ])('暂时性%s使用脱敏失败码', async (_name, failure, expectedCode) => {
    const store = fixture();
    store.summaries.apply.mockRejectedValueOnce(failure);

    await expect(store.processor.process(job())).rejects.toBe(failure);
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toEqual({
      $set: { failureCode: expectedCode },
    });
  });

  it('最后一次暂时性失败写 failed，同时让 BullMQ 保留失败 Job', async () => {
    const store = fixture();
    const failure = new Error('OP_GATEWAY_UNAVAILABLE');
    store.summaries.apply.mockRejectedValueOnce(failure);

    await expect(store.processor.process(job({
      attemptsMade: 2,
      opts: { attempts: 3 },
    }))).rejects.toBe(failure);

    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'failed', failureCode: 'OP_GATEWAY_UNAVAILABLE' },
    });
  });

  it('业务与 Inbox 均已提交后审计失败只记录告警，不反向标记失败', async () => {
    const store = fixture();
    store.audit.recordSystem.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(store.processor.process(job())).resolves.toBe(1);

    expect(store.inbox.updateOne).toHaveBeenCalledTimes(1);
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'completed' },
    });
  });

  it('永久失败审计异常不覆盖已形成的失败终态', async () => {
    const invalid = Buffer.from('{}');
    const store = fixture(claimedRecord({ payloadHash: hashOpPayload(invalid) }));
    store.crypto.unprotect.mockReturnValueOnce(invalid);
    store.audit.recordSystem.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(store.processor.process(job())).resolves.toBe(1);
    expect(store.inbox.updateOne).toHaveBeenCalledTimes(1);
    expect(store.inbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'failed', failureCode: 'OP_WEBHOOK_BODY_INVALID' },
    });
  });

  it('业务已提交但 Inbox 租约丢失时不进入通用失败处理', async () => {
    const store = fixture();
    store.inbox.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(store.processor.process(job())).rejects.toThrow('OP_INBOX_LEASE_LOST');

    expect(store.summaries.apply).toHaveBeenCalledOnce();
    expect(store.inbox.updateOne).toHaveBeenCalledTimes(1);
    expect(store.audit.recordSystem).not.toHaveBeenCalled();
  });
});
