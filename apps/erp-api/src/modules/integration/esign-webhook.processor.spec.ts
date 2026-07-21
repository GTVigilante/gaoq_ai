import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import type { ESignWebhookInboxDocument } from './esign-webhook-inbox.schema.js';
import {
  ESignWebhookProcessor,
  projectESignFlow,
} from './esign-webhook.processor.js';
import type { ESignWebhookJobData } from './esign-webhook.queue.js';

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
    const processor = new ESignWebhookProcessor(
      inbox as unknown as Model<ESignWebhookInboxDocument>,
      flows as unknown as Model<ESignFlowDocument>,
      crypto as unknown as ESignWebhookCryptoService,
      audit as unknown as AuditService,
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
    const processor = new ESignWebhookProcessor(
      inbox as unknown as Model<ESignWebhookInboxDocument>,
      flows as unknown as Model<ESignFlowDocument>,
      crypto as unknown as ESignWebhookCryptoService,
      audit as unknown as AuditService,
    );
    await processor.process({
      name: 'process:esign:webhook',
      data: { inboxId: '01K00000000000000000000000', tenantId: 'tenant-001' },
    } as Job<ESignWebhookJobData>);
    expect(crypto.unprotect).not.toHaveBeenCalled();
    expect(flows.findOne).not.toHaveBeenCalled();
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
