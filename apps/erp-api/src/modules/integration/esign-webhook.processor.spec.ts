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
import type { ESignQueueJobData, ESignWebhookJobData } from './esign-webhook.queue.js';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('ESignWebhookProcessor', () => {
  it('流程完成回调只推进 provider_completed，不冒充归档证据', async () => {
    const occurredAt = new Date('2026-07-21T08:00:00.000Z');
    const claimed = {
      id: '01K00000000000000000000000', tenantId: 'tenant-001', appId: 'app12345',
      action: 'SIGN_FLOW_COMPLETE', providerOccurredAt: occurredAt,
    };
    const flow = {
      id: '01K00000000000000000000001', tenantId: 'tenant-001', appId: 'app12345',
      status: 'partial_signed', providerStatus: null, providerOccurredAt: null,
      reviewRequired: false, version: 2,
    };
    const inbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const flows = {
      findOne: vi.fn().mockReturnValue(query(flow)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const crypto = { unprotect: vi.fn().mockReturnValue(Buffer.from(JSON.stringify({
      action: 'SIGN_FLOW_COMPLETE', timestamp: occurredAt.getTime(),
      data: { signFlowId: 'external-flow-001', signFlowStatus: 2 },
    }))) };
    const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
    const evidence = { archiveCompletedFlow: vi.fn() };
    const context = { run: vi.fn() };
    const queue = { add: vi.fn().mockResolvedValue({ id: 'evidence-job-001' }) };
    const processor = new ESignWebhookProcessor(
      inbox as unknown as Model<ESignWebhookInboxDocument>,
      flows as unknown as Model<ESignFlowDocument>,
      crypto as unknown as ESignWebhookCryptoService,
      audit as unknown as AuditService,
      evidence as unknown as ESignEvidenceService,
      {} as ESignReconciliationService,
      context as unknown as TenantContextService,
      queue as unknown as Queue<ESignQueueJobData>,
    );
    await expect(processor.process({
      name: 'process:esign:webhook', data: { inboxId: claimed.id, tenantId: claimed.tenantId },
    } as Job<ESignWebhookJobData>)).resolves.toBe(1);
    const update = flows.updateOne.mock.calls[0]?.[1] as unknown as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(flows.updateOne.mock.calls[0]?.[0]).toMatchObject({ id: flow.id, version: 2 });
    expect(update.$set).toMatchObject({ status: 'provider_completed' });
    expect(JSON.stringify(flows.updateOne.mock.calls)).not.toContain('signedEvidenceId');
    expect(queue.add).toHaveBeenCalledWith(
      'archive:esign:evidence', { flowId: flow.id, tenantId: flow.tenantId },
      expect.objectContaining({ attempts: 12 }),
    );
  });

  it('未知 action 只标记 ignored，不解密也不查询流程', async () => {
    const inbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query({
        id: '01K00000000000000000000000', tenantId: 'tenant-001', appId: 'app12345',
        action: 'FUTURE_ACTION', providerOccurredAt: new Date(),
      })),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const flows = { findOne: vi.fn() };
    const crypto = { unprotect: vi.fn() };
    const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
    const evidence = { archiveCompletedFlow: vi.fn() };
    const context = { run: vi.fn() };
    const queue = { add: vi.fn() };
    const processor = new ESignWebhookProcessor(
      inbox as unknown as Model<ESignWebhookInboxDocument>,
      flows as unknown as Model<ESignFlowDocument>,
      crypto as unknown as ESignWebhookCryptoService,
      audit as unknown as AuditService,
      evidence as unknown as ESignEvidenceService,
      {} as ESignReconciliationService,
      context as unknown as TenantContextService,
      queue as unknown as Queue<ESignQueueJobData>,
    );
    await processor.process({
      name: 'process:esign:webhook',
      data: { inboxId: '01K00000000000000000000000', tenantId: 'tenant-001' },
    } as Job<ESignWebhookJobData>);
    expect(crypto.unprotect).not.toHaveBeenCalled();
    expect(flows.findOne).not.toHaveBeenCalled();
  });

  it('证据归档任务只在显式最小系统 Scope 下调用应用服务', async () => {
    const archiveCompletedFlow = vi.fn().mockResolvedValue({ evidenceId: 'evidence-001' });
    const trustedContexts: unknown[] = [];
    const run = vi.fn().mockImplementation((trusted: unknown, callback: () => Promise<unknown>) => {
      trustedContexts.push(trusted);
      return callback();
    });
    const processor = new ESignWebhookProcessor(
      {} as Model<ESignWebhookInboxDocument>, {} as Model<ESignFlowDocument>,
      {} as ESignWebhookCryptoService, {} as AuditService,
      { archiveCompletedFlow } as unknown as ESignEvidenceService,
      {} as ESignReconciliationService,
      { run } as unknown as TenantContextService,
      {} as Queue<ESignQueueJobData>,
    );
    await expect(processor.process({
      name: 'archive:esign:evidence', data: {
        flowId: '01K00000000000000000000001', tenantId: 'tenant-001',
      },
    } as Job<ESignQueueJobData>)).resolves.toBe(1);
    const trusted = trustedContexts[0] as {
      readonly tenant: Readonly<Record<string, unknown>>;
      readonly actor: { readonly scopes: readonly string[] } & Readonly<Record<string, unknown>>;
    };
    expect(trusted.tenant).toMatchObject({ tenantId: 'tenant-001', source: 'service_identity' });
    expect(trusted.actor).toMatchObject({ actorType: 'system_job', tenantId: 'tenant-001' });
    expect(trusted.actor.scopes).toContain('erp:integration:esign:archive');
    expect(trusted.actor.scopes).toContain('erp:integration:esign:apply');
    expect(archiveCompletedFlow).toHaveBeenCalledWith('01K00000000000000000000001');
  });
});

describe('projectESignFlow', () => {
  it('未知状态和终态冲突只转人工复核，不倒退状态', () => {
    expect(projectESignFlow('partial_signed', null, false, null, 'SIGN_FLOW_COMPLETE', 99))
      .toMatchObject({ status: 'partial_signed', reviewRequired: true });
    expect(projectESignFlow('provider_completed', 2, false, null, 'SIGN_FLOW_COMPLETE', 7))
      .toMatchObject({ status: 'provider_completed', reviewRequired: true });
    expect(projectESignFlow('completed', 2, false, null, 'SIGN_MISSON_COMPLETE', null))
      .toMatchObject({ status: 'completed', changed: false });
  });
});
