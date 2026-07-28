import type { Job, Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { ESignEvidenceService } from './esign-evidence.service.js';
import { projectESignFlow } from './esign-flow-projection.js';
import type { ESignReconciliationService } from './esign-reconciliation.service.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import type { ESignWebhookInboxDocument } from './esign-webhook-inbox.schema.js';
import { ESignWebhookProcessor } from './esign-webhook.processor.js';
import {
  ESIGN_ARCHIVE_EVIDENCE_JOB,
  ESIGN_PROCESS_WEBHOOK_JOB,
  ESIGN_RECONCILE_FLOWS_JOB,
  createESignEvidenceJobId,
  createESignWebhookJobId,
  type ESignQueueJobData,
} from './esign-webhook.queue.js';

const INBOX_ID = '01K00000000000000000000000';
const FLOW_ID = '01K00000000000000000000001';
const TENANT_ID = 'tenant-001';
const APP_ID = 'app12345';
const OCCURRED_AT = new Date('2026-07-21T08:00:00.000Z');
const PROVIDER_EVENT_ID = 'A'.repeat(43);

function query<T>(value: T) {
  const chain = {
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(value),
  };
  return chain;
}

function fixture() {
  const claimed = {
    id: INBOX_ID,
    tenantId: TENANT_ID,
    appId: APP_ID,
    providerEventId: PROVIDER_EVENT_ID,
    action: 'SIGN_FLOW_COMPLETE',
    providerOccurredAt: OCCURRED_AT,
    attempts: 0,
  };
  const flow = {
    id: FLOW_ID,
    tenantId: TENANT_ID,
    appId: APP_ID,
    status: 'partial_signed',
    providerStatus: null,
    providerOccurredAt: null as Date | null,
    reviewRequired: false,
    reviewCode: null,
    version: 2,
  };
  const inbox = {
    findOneAndUpdate: vi.fn().mockImplementation(
      (_filter: unknown, update: {
        readonly $set: Readonly<Record<string, unknown>>;
        readonly $inc: { readonly attempts: number };
      }) => query({
        ...claimed,
        ...update.$set,
        attempts: claimed.attempts + update.$inc.attempts,
      }),
    ),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const flows = {
    findOne: vi.fn().mockReturnValue(query(flow)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const unprotect = vi.fn().mockReturnValue(Buffer.from(JSON.stringify({
    action: 'SIGN_FLOW_COMPLETE',
    timestamp: OCCURRED_AT.getTime(),
    data: { signFlowId: 'external-flow-001', signFlowStatus: 2 },
  })));
  const recordSystem = vi.fn().mockResolvedValue(undefined);
  const archiveCompletedFlow = vi.fn().mockResolvedValue({ evidenceId: 'evidence-001' });
  const runStaleBatch = vi.fn().mockResolvedValue(4);
  const trustedContexts: unknown[] = [];
  const run = vi.fn().mockImplementation(
    (trusted: unknown, callback: () => Promise<unknown>) => {
      trustedContexts.push(trusted);
      return callback();
    },
  );
  const queueAdd = vi.fn().mockResolvedValue({ id: 'evidence-job-001' });
  const processor = new ESignWebhookProcessor(
    inbox as unknown as Model<ESignWebhookInboxDocument>,
    flows as unknown as Model<ESignFlowDocument>,
    { unprotect } as unknown as ESignWebhookCryptoService,
    { recordSystem } as unknown as AuditService,
    { archiveCompletedFlow } as unknown as ESignEvidenceService,
    { runStaleBatch } as unknown as ESignReconciliationService,
    { run } as unknown as TenantContextService,
    { add: queueAdd } as unknown as Queue<ESignQueueJobData>,
  );
  return {
    processor,
    claimed,
    flow,
    inbox,
    flows,
    unprotect,
    recordSystem,
    archiveCompletedFlow,
    runStaleBatch,
    trustedContexts,
    run,
    queueAdd,
  };
}

function job(name: string, data: unknown = {}, id?: string): Job<ESignQueueJobData> {
  return { name, data, ...(id === undefined ? {} : { id }) } as Job<ESignQueueJobData>;
}

function webhookJob(): Job<ESignQueueJobData> {
  return job(ESIGN_PROCESS_WEBHOOK_JOB, {
    inboxId: INBOX_ID,
    tenantId: TENANT_ID,
    providerEventId: PROVIDER_EVENT_ID,
  }, createESignWebhookJobId(TENANT_ID, INBOX_ID, PROVIDER_EVENT_ID));
}

describe('ESignWebhookProcessor', () => {
  it('分派对账任务并拒绝额外参数', async () => {
    const store = fixture();
    await expect(store.processor.process(
      job(ESIGN_RECONCILE_FLOWS_JOB),
    )).resolves.toBe(4);
    expect(store.runStaleBatch).toHaveBeenCalledOnce();
    await expect(store.processor.process(
      job(ESIGN_RECONCILE_FLOWS_JOB, { tenantId: TENANT_ID }),
    )).rejects.toThrow();
  });

  it('证据归档任务只在显式最小系统 Scope 下调用应用服务', async () => {
    const store = fixture();
    await expect(store.processor.process(job(ESIGN_ARCHIVE_EVIDENCE_JOB, {
      flowId: FLOW_ID,
      tenantId: TENANT_ID,
    }, createESignEvidenceJobId(TENANT_ID, FLOW_ID)))).resolves.toBe(1);
    const trusted = store.trustedContexts[0] as {
      readonly tenant: Readonly<Record<string, unknown>>;
      readonly actor: { readonly scopes: readonly string[] } & Readonly<Record<string, unknown>>;
    };
    expect(trusted.tenant).toMatchObject({
      tenantId: TENANT_ID,
      source: 'service_identity',
    });
    expect(trusted.actor).toMatchObject({
      actorType: 'system_job',
      tenantId: TENANT_ID,
    });
    expect(trusted.actor.scopes).toEqual([
      'erp:integration:esign:archive',
      'erp:integration:esign:apply',
      'erp:recruitment:offer:read_all',
    ]);
    expect(store.archiveCompletedFlow).toHaveBeenCalledWith(FLOW_ID);
  });

  it('拒绝非法证据归档、未知任务和非法回调任务', async () => {
    const store = fixture();
    await expect(store.processor.process(job(ESIGN_ARCHIVE_EVIDENCE_JOB, {
      flowId: 'bad',
      tenantId: TENANT_ID,
    }))).rejects.toThrow();
    await expect(store.processor.process(job('unknown'))).rejects.toThrow(
      'ESIGN_WEBHOOK_JOB_UNKNOWN',
    );
    await expect(store.processor.process(job(ESIGN_PROCESS_WEBHOOK_JOB, {
      inboxId: INBOX_ID,
      tenantId: TENANT_ID,
      extra: true,
    }))).rejects.toThrow();
    await expect(store.processor.process(job(ESIGN_ARCHIVE_EVIDENCE_JOB, {
      flowId: FLOW_ID,
      tenantId: TENANT_ID,
    }, 'forged-evidence-job'))).rejects.toThrow('ESIGN_EVIDENCE_JOB_ID_MISMATCH');
    await expect(store.processor.process(job(ESIGN_PROCESS_WEBHOOK_JOB, {
      inboxId: INBOX_ID,
      tenantId: TENANT_ID,
      providerEventId: PROVIDER_EVENT_ID,
    }, 'forged-webhook-job'))).rejects.toThrow('ESIGN_WEBHOOK_JOB_ID_MISMATCH');
    expect(store.inbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('只领取待处理、失败或租约过期的 Inbox', async () => {
    const store = fixture();
    await store.processor.process(webhookJob());
    const filter = store.inbox.findOneAndUpdate.mock.calls[0]?.[0] as {
      $or?: readonly unknown[];
    };
    expect(filter.$or).toEqual([
      { status: { $in: ['pending', 'failed'] } },
      {
        status: 'processing',
        processingStartedAt: { $lte: expect.any(Date) as Date },
      },
    ]);
    const claimUpdate = store.inbox.findOneAndUpdate.mock.calls[0]?.[1] as {
      readonly $set: {
        readonly processingToken: string;
        readonly processingJobId: string;
      };
      readonly $inc: { readonly attempts: number };
    };
    const finishFilter = store.inbox.updateOne.mock.calls[0]?.[0] as
      Readonly<Record<string, unknown>>;
    expect(claimUpdate.$set.processingToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(claimUpdate.$set.processingJobId).toBe(
      createESignWebhookJobId(TENANT_ID, INBOX_ID, PROVIDER_EVENT_ID),
    );
    expect(claimUpdate.$inc).toEqual({ attempts: 1 });
    expect(finishFilter).toMatchObject({
      tenantId: TENANT_ID,
      id: INBOX_ID,
      status: 'processing',
      attempts: 1,
      processingToken: claimUpdate.$set.processingToken,
      processingJobId: claimUpdate.$set.processingJobId,
    });
  });

  it('领取结果的供应商事件或租约证据错位时停止处理', async () => {
    const eventMismatch = fixture();
    eventMismatch.claimed.providerEventId = 'B'.repeat(43);
    await expect(eventMismatch.processor.process(webhookJob()))
      .rejects.toThrow('ESIGN_WEBHOOK_CLAIM_INTEGRITY_INVALID');
    expect(eventMismatch.unprotect).not.toHaveBeenCalled();
    expect(eventMismatch.inbox.updateOne).not.toHaveBeenCalled();

    const tokenMismatch = fixture();
    tokenMismatch.inbox.findOneAndUpdate.mockImplementationOnce(
      (_filter: unknown, update: {
        readonly $set: Readonly<Record<string, unknown>>;
        readonly $inc: { readonly attempts: number };
      }) => query({
        ...tokenMismatch.claimed,
        ...update.$set,
        processingToken: 'B'.repeat(22),
        attempts: tokenMismatch.claimed.attempts + update.$inc.attempts,
      }),
    );
    await expect(tokenMismatch.processor.process(webhookJob()))
      .rejects.toThrow('ESIGN_WEBHOOK_CLAIM_INTEGRITY_INVALID');
    expect(tokenMismatch.unprotect).not.toHaveBeenCalled();
  });

  it('没有可领取 Inbox 时幂等返回零', async () => {
    const store = fixture();
    store.inbox.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(store.processor.process(webhookJob())).resolves.toBe(0);
    expect(store.unprotect).not.toHaveBeenCalled();
  });

  it('未知 action 只标记 ignored，不解密也不查询流程', async () => {
    const store = fixture();
    store.claimed.action = 'FUTURE_ACTION';
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    expect(store.unprotect).not.toHaveBeenCalled();
    expect(store.flows.findOne).not.toHaveBeenCalled();
    const update = store.inbox.updateOne.mock.calls[0]?.[1] as {
      $set?: unknown;
    };
    expect(update.$set).toMatchObject({
      status: 'ignored',
      failureCode: 'ESIGN_ACTION_UNKNOWN',
    });
  });

  it('未知 action 的审计故障不改写 ignored 终态', async () => {
    const store = fixture();
    store.claimed.action = 'FUTURE_ACTION';
    store.recordSystem.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    expect(store.inbox.updateOne).toHaveBeenCalledOnce();
  });

  it('流程完成回调只推进 provider_completed 并投递证据归档', async () => {
    const store = fixture();
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    const update = store.flows.updateOne.mock.calls[0]?.[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(store.flows.updateOne.mock.calls[0]?.[0]).toMatchObject({
      id: FLOW_ID,
      version: 2,
    });
    expect(update.$set).toMatchObject({ status: 'provider_completed' });
    expect(JSON.stringify(store.flows.updateOne.mock.calls)).not.toContain('signedEvidenceId');
    expect(store.queueAdd).toHaveBeenCalledWith(
      ESIGN_ARCHIVE_EVIDENCE_JOB,
      { flowId: FLOW_ID, tenantId: TENANT_ID },
      {
        jobId: createESignEvidenceJobId(TENANT_ID, FLOW_ID),
        attempts: 12,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1_000,
        removeOnFail: true,
      },
    );
  });

  it('任务完成回调允许缺少流程状态且不投递证据归档', async () => {
    const store = fixture();
    store.claimed.action = 'SIGN_MISSON_COMPLETE';
    store.unprotect.mockReturnValueOnce(Buffer.from(JSON.stringify({
      action: 'SIGN_MISSON_COMPLETE',
      timestamp: OCCURRED_AT.getTime(),
      data: { signFlowId: 'external-flow-001' },
    })));
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    expect(store.queueAdd).not.toHaveBeenCalled();
    const audit = store.recordSystem.mock.calls[0]?.[1] as { metadata?: unknown } | undefined;
    expect(audit?.metadata).toMatchObject({ providerStatus: -1 });
  });

  it.each([
    [Buffer.from('{'), '非法 JSON'],
    [Buffer.from(JSON.stringify({
      action: 'SIGN_FLOW_COMPLETE',
      timestamp: -1,
      data: { signFlowId: 'external-flow-001', signFlowStatus: 2 },
    })), '非法协议结构'],
  ])('非法回调正文进入失败终态：%s', async (raw) => {
    const store = fixture();
    store.unprotect.mockReturnValueOnce(raw);
    await expect(store.processor.process(webhookJob())).rejects.toThrow();
    const failed = store.inbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(failed.$set).toMatchObject({
      status: 'failed',
      failureCode: 'ESIGN_WEBHOOK_BODY_INVALID',
    });
  });

  it.each([
    [{
      action: 'SIGN_MISSON_COMPLETE',
      timestamp: OCCURRED_AT.getTime(),
      data: { signFlowId: 'external-flow-001' },
    }, 'ESIGN_WEBHOOK_ENVELOPE_MISMATCH'],
    [{
      action: 'SIGN_FLOW_COMPLETE',
      timestamp: OCCURRED_AT.getTime() + 1,
      data: { signFlowId: 'external-flow-001', signFlowStatus: 2 },
    }, 'ESIGN_WEBHOOK_ENVELOPE_MISMATCH'],
    [{
      action: 'SIGN_FLOW_COMPLETE',
      timestamp: OCCURRED_AT.getTime(),
      data: { signFlowId: 'external-flow-001' },
    }, 'ESIGN_FLOW_STATUS_REQUIRED'],
  ])('拒绝信封证据不一致：%s', async (envelope, expectedCode) => {
    const store = fixture();
    store.unprotect.mockReturnValueOnce(Buffer.from(JSON.stringify(envelope)));
    await expect(store.processor.process(webhookJob())).rejects.toThrow(expectedCode);
  });

  it('拒绝未绑定的外部签署流程', async () => {
    const store = fixture();
    store.flows.findOne.mockReturnValueOnce(query(null));
    await expect(store.processor.process(webhookJob())).rejects.toThrow(
      'ESIGN_FLOW_UNBOUND',
    );
  });

  it('乱序事件标记 ignored 且不倒退流程', async () => {
    const store = fixture();
    store.flow.providerOccurredAt = new Date(OCCURRED_AT.getTime() + 1);
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    expect(store.flows.updateOne).not.toHaveBeenCalled();
    expect(store.queueAdd).not.toHaveBeenCalled();
    const update = store.inbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(update.$set).toMatchObject({
      status: 'ignored',
      failureCode: 'ESIGN_EVENT_OUT_OF_ORDER',
    });
  });

  it('无变化投影不重复更新流程', async () => {
    const store = fixture();
    Object.assign(store.flow, {
      status: 'completed',
      providerStatus: 2,
    });
    store.claimed.action = 'SIGN_MISSON_COMPLETE';
    store.unprotect.mockReturnValueOnce(Buffer.from(JSON.stringify({
      action: 'SIGN_MISSON_COMPLETE',
      timestamp: OCCURRED_AT.getTime(),
      data: { signFlowId: 'external-flow-001' },
    })));
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    expect(store.flows.updateOne).not.toHaveBeenCalled();
    expect(store.queueAdd).not.toHaveBeenCalled();
  });

  it('流程乐观锁冲突时失败关闭', async () => {
    const store = fixture();
    store.flows.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.processor.process(webhookJob())).rejects.toThrow(
      'ESIGN_FLOW_VERSION_CONFLICT',
    );
  });

  it('需要人工复核的投影写入失败审计结果', async () => {
    const store = fixture();
    store.unprotect.mockReturnValueOnce(Buffer.from(JSON.stringify({
      action: 'SIGN_FLOW_COMPLETE',
      timestamp: OCCURRED_AT.getTime(),
      data: { signFlowId: 'external-flow-001', signFlowStatus: 99 },
    })));
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    const audit = store.recordSystem.mock.calls[0]?.[1] as {
      outcome?: string;
      metadata?: unknown;
    } | undefined;
    expect(audit?.outcome).toBe('failure');
    expect(audit?.metadata).toMatchObject({ reviewRequired: true });
  });

  it('流程投影后的审计故障不改写完成终态', async () => {
    const store = fixture();
    store.recordSystem.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(store.processor.process(webhookJob())).resolves.toBe(1);
    const statuses = store.inbox.updateOne.mock.calls.map(
      (call) => (call[1] as { $set?: { status?: string } }).$set?.status,
    );
    expect(statuses).toEqual(['completed']);
  });

  it('证据归档入队失败会保留失败 Inbox 供确定性重试', async () => {
    const store = fixture();
    const error = new Error('ESIGN_EVIDENCE_QUEUE_UNAVAILABLE');
    store.queueAdd.mockRejectedValueOnce(error);
    await expect(store.processor.process(webhookJob())).rejects.toBe(error);
    const failed = store.inbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(failed.$set).toMatchObject({
      status: 'failed',
      failureCode: 'ESIGN_EVIDENCE_QUEUE_UNAVAILABLE',
    });
  });

  it('完成 Inbox 丢失租约时不覆盖并发终态', async () => {
    const store = fixture();
    store.inbox.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(store.processor.process(webhookJob())).rejects.toThrow(
      'ESIGN_WEBHOOK_INBOX_LEASE_LOST',
    );
    expect(store.inbox.updateOne).toHaveBeenCalledOnce();
  });

  it('失败 Inbox 也丢失租约时停止覆盖', async () => {
    const store = fixture();
    store.unprotect.mockReturnValueOnce(Buffer.from('{'));
    store.inbox.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.processor.process(webhookJob())).rejects.toThrow(
      'ESIGN_WEBHOOK_INBOX_LEASE_LOST',
    );
  });

  it('未知错误正文使用稳定兜底码', async () => {
    const store = fixture();
    const error = new Error('供应商原始敏感错误');
    store.unprotect.mockImplementationOnce(() => {
      throw error;
    });
    await expect(store.processor.process(webhookJob())).rejects.toBe(error);
    const failed = store.inbox.updateOne.mock.calls[0]?.[1] as { $set?: unknown };
    expect(failed.$set).toMatchObject({
      failureCode: 'ESIGN_WEBHOOK_PROCESSING_FAILED',
    });
  });
});

describe('projectESignFlow', () => {
  it('未知状态和终态冲突只转人工复核，不倒退状态', () => {
    expect(projectESignFlow(
      'partial_signed', null, false, null, 'SIGN_FLOW_COMPLETE', 99,
    )).toMatchObject({ status: 'partial_signed', reviewRequired: true });
    expect(projectESignFlow(
      'provider_completed', 2, false, null, 'SIGN_FLOW_COMPLETE', 7,
    )).toMatchObject({ status: 'provider_completed', reviewRequired: true });
    expect(projectESignFlow(
      'completed', 2, false, null, 'SIGN_MISSON_COMPLETE', null,
    )).toMatchObject({ status: 'completed', changed: false });
  });
});
