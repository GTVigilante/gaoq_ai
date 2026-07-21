import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ESignAdapter } from './esign.adapter.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import { ESignReconciliationService } from './esign-reconciliation.service.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import type { ESignQueueJobData } from './esign-webhook.queue.js';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function listQuery<T>(value: T) {
  return {
    sort: () => ({
      limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
    }),
  };
}

const FLOW = {
  id: '01K00000000000000000000001', tenantId: 'tenant-001', provider: 'esign_cn',
  appId: 'app12345', offerId: '01K00000000000000000000002',
  status: 'partial_signed', providerStatus: 1, providerOccurredAt: new Date('2026-07-21T07:00:00Z'),
  reviewRequired: false, reviewCode: null, version: 2,
};

function fixture(providerStatus: number) {
  const adapter = { getFlow: vi.fn().mockResolvedValue(providerStatus) };
  const bindings = { findOne: vi.fn().mockReturnValue(query({
    appId: 'app12345', credentialSecretRef: 'GAOQ_ESIGN_APP_TEST',
  })) };
  const flows = {
    find: vi.fn().mockReturnValue(listQuery([FLOW])),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'evidence-job-001' }) };
  const service = new ESignReconciliationService(
    adapter as unknown as ESignAdapter,
    { resolve: () => 'test-only-app-secret' },
    { unprotectExternalId: () => 'external-flow-001' } as unknown as ESignWebhookCryptoService,
    audit as unknown as AuditService,
    bindings as unknown as Model<ESignBindingDocument>,
    flows as unknown as Model<ESignFlowDocument>,
    queue as unknown as Queue<ESignQueueJobData>,
  );
  return { service, adapter, bindings, flows, audit, queue };
}

describe('ESignReconciliationService', () => {
  it('补拉确认供应商完成后投影 provider_completed 并排队证据归档', async () => {
    const store = fixture(2);
    await expect(store.service.runStaleBatch(new Date('2026-07-21T08:00:00Z'))).resolves.toBe(1);
    const update = store.flows.updateOne.mock.calls[0]?.[1] as unknown as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set).toMatchObject({
      status: 'provider_completed', providerStatus: 2,
      lastProviderAction: 'RECONCILE_FLOW_DETAIL',
    });
    expect(store.queue.add).toHaveBeenCalledWith(
      'archive:esign:evidence', { flowId: FLOW.id, tenantId: FLOW.tenantId },
      expect.objectContaining({ attempts: 12 }),
    );
  });

  it('供应商仍在签署中时只刷新观测时间，不倒退已有 partial_signed', async () => {
    const store = fixture(1);
    await store.service.runStaleBatch(new Date('2026-07-21T08:00:00Z'));
    const update = store.flows.updateOne.mock.calls[0]?.[1] as unknown as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set).toMatchObject({ status: 'partial_signed', providerStatus: 1 });
    expect(store.queue.add).not.toHaveBeenCalled();
  });

  it('单流程供应商故障转安全审计失败，不阻断整批调度', async () => {
    const store = fixture(1);
    store.adapter.getFlow.mockRejectedValue(new Error('ESIGN_HTTP_UNAVAILABLE'));
    await expect(store.service.runStaleBatch(new Date('2026-07-21T08:00:00Z'))).resolves.toBe(0);
    expect(store.flows.updateOne).not.toHaveBeenCalled();
    expect(store.audit.recordSystem).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      outcome: 'failure', metadata: { failureCode: 'ESIGN_HTTP_UNAVAILABLE' },
    }));
  });
});
